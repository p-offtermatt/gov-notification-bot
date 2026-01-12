import { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { bech32 } from "bech32";

interface Vote {
  voter: string;
  options: Array<{ option: string; weight: string }>;
}

interface Validator {
  operator_address: string;
  tokens: string;
  description: {
    moniker: string;
  };
}

interface ValidatorInfo {
  moniker: string;
  tokens: number;
  operatorAddress: string;
  votingPowerPct: number;
}

interface SeenVotes {
  [voter: string]: {
    option: string;
    timestamp: string;
  };
}

// Scheduled function configuration
export const config: Config = {
  schedule: "* * * * *", // Every minute
};

export default async function handler() {
  const lcdUrl = process.env.COSMOS_LCD_URL || "https://cosmos-lcd.publicnode.com";
  const proposalIds = (process.env.PROPOSAL_IDS || "").split(",").filter(Boolean);
  const slackWebhook = process.env.SLACK_WEBHOOK_URL;
  const errorWebhook = process.env.SLACK_ERROR_WEBHOOK_URL;

  if (proposalIds.length === 0) {
    return new Response("PROPOSAL_IDS not configured", { status: 400 });
  }

  if (!slackWebhook) {
    return new Response("SLACK_WEBHOOK_URL not configured", { status: 400 });
  }

  const store = getStore("gov-votes");

  try {
    for (const proposalId of proposalIds) {
      await processProposal(proposalId.trim(), lcdUrl, store, slackWebhook);
    }
    return new Response("OK", { status: 200 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorWebhook) {
      await postErrorToSlack(errorWebhook, errorMessage);
    }
    throw error;
  }
}

async function processProposal(
  proposalId: string,
  lcdUrl: string,
  store: ReturnType<typeof getStore>,
  slackWebhook: string
): Promise<number> {
  // Get all votes for the proposal
  const votes = await fetchAllVotes(lcdUrl, proposalId);

  // Get validators for moniker + voting power lookup
  const validators = await fetchValidators(lcdUrl);

  // Build mapping from account addresses to validator info
  const validatorByAccount = buildAccountToValidatorMapping(validators);

  // Load previously seen votes with strong consistency to avoid duplicates
  const seenKey = `seen_votes_${proposalId}`;
  let seenVotes: SeenVotes = {};
  try {
    const seenData = await store.get(seenKey, { type: "json", consistency: "strong" }) as SeenVotes | null;
    if (seenData) {
      seenVotes = seenData;
    }
  } catch {
    // No existing data, start fresh
  }

  // Calculate total staked tokens for percentage calculations
  let totalStakedTokens = 0;
  for (const validator of validators.values()) {
    totalStakedTokens += validator.tokens;
  }

  const newValidatorVotes: Array<{ vote: Vote; validator: ValidatorInfo }> = [];
  const newWhaleVotes: Array<{ vote: Vote; votingPowerPct: number }> = [];

  for (const vote of votes) {
    if (!(vote.voter in seenVotes)) {
      // Mark as seen regardless of whether it's a validator
      seenVotes[vote.voter] = {
        option: vote.options?.[0]?.option || "UNKNOWN",
        timestamp: new Date().toISOString(),
      };

      // Check if it's a validator vote
      const validator = validatorByAccount.get(vote.voter);
      if (validator) {
        newValidatorVotes.push({ vote, validator });
      } else {
        // Check if it's a whale delegator (>0.05% VP)
        const delegatorVP = await fetchDelegatorVotingPower(lcdUrl, vote.voter, totalStakedTokens);
        if (delegatorVP >= 0.05) {
          newWhaleVotes.push({ vote, votingPowerPct: delegatorVP });
        }
      }
    }
  }

  // Notify for each new validator vote
  for (const { vote, validator } of newValidatorVotes) {
    await notifyVote(vote, proposalId, validator, slackWebhook);
  }

  // Notify for each new whale vote
  for (const { vote, votingPowerPct } of newWhaleVotes) {
    await notifyWhaleVote(vote, proposalId, votingPowerPct, slackWebhook);
  }

  // Persist updated seen votes
  await store.setJSON(seenKey, seenVotes);

  return newValidatorVotes.length;
}

async function fetchAllVotes(lcdUrl: string, proposalId: string): Promise<Vote[]> {
  const votes: Vote[] = [];
  let paginationKey: string | null = null;

  while (true) {
    const url = new URL(`${lcdUrl}/cosmos/gov/v1/proposals/${proposalId}/votes`);
    url.searchParams.set("pagination.limit", "100");
    if (paginationKey) {
      url.searchParams.set("pagination.key", paginationKey);
    }

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      throw new Error(`Failed to fetch votes: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    votes.push(...(data.votes || []));
    paginationKey = data.pagination?.next_key || null;

    if (!paginationKey) {
      break;
    }
  }

  return votes;
}

async function fetchValidators(
  lcdUrl: string
): Promise<Map<string, ValidatorInfo>> {
  const validators = new Map<string, ValidatorInfo>();
  let paginationKey: string | null = null;
  let totalPower = 0;

  // First pass: collect all validators and total power
  const validatorList: Array<{ address: string; info: ValidatorInfo }> = [];

  while (true) {
    const url = new URL(`${lcdUrl}/cosmos/staking/v1beta1/validators`);
    url.searchParams.set("pagination.limit", "100");
    url.searchParams.set("status", "BOND_STATUS_BONDED");
    if (paginationKey) {
      url.searchParams.set("pagination.key", paginationKey);
    }

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      throw new Error(`Failed to fetch validators: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();

    for (const v of data.validators || []) {
      const tokens = parseInt(v.tokens, 10);
      totalPower += tokens;
      validatorList.push({
        address: v.operator_address,
        info: {
          moniker: v.description.moniker,
          tokens,
          operatorAddress: v.operator_address,
          votingPowerPct: 0, // Calculate after we have total
        },
      });
    }

    paginationKey = data.pagination?.next_key || null;
    if (!paginationKey) {
      break;
    }
  }

  // Second pass: calculate voting power percentages
  for (const { address, info } of validatorList) {
    info.votingPowerPct = totalPower > 0 ? (info.tokens / totalPower) * 100 : 0;
    validators.set(address, info);
  }

  return validators;
}

function operatorToAccount(operatorAddress: string): string | null {
  try {
    const decoded = bech32.decode(operatorAddress);
    if (decoded.prefix === "cosmosvaloper") {
      return bech32.encode("cosmos", decoded.words);
    }
  } catch {
    // Invalid address
  }
  return null;
}

function buildAccountToValidatorMapping(
  validators: Map<string, ValidatorInfo>
): Map<string, ValidatorInfo> {
  const mapping = new Map<string, ValidatorInfo>();

  for (const [operatorAddress, info] of validators) {
    const accountAddress = operatorToAccount(operatorAddress);
    if (accountAddress) {
      mapping.set(accountAddress, info);
    }
  }

  return mapping;
}

async function notifyVote(
  vote: Vote,
  proposalId: string,
  validator: ValidatorInfo,
  slackWebhook: string
): Promise<void> {
  const rawOption = vote.options?.[0]?.option || "UNKNOWN";
  const option = formatVoteOption(rawOption);
  const emoji = getVoteEmoji(rawOption);
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const { moniker, votingPowerPct } = validator;
  const message = `${emoji} ${moniker} (${votingPowerPct.toFixed(1)}% VP) votes ${option} on proposal ${proposalId} at ${timestamp}`;

  const resp = await fetch(slackWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`Failed to post to Slack: ${resp.status} ${resp.statusText}`);
  }
}

function formatVoteOption(option: string): string {
  const mapping: Record<string, string> = {
    VOTE_OPTION_YES: "Yes",
    VOTE_OPTION_NO: "No",
    VOTE_OPTION_ABSTAIN: "Abstain",
    VOTE_OPTION_NO_WITH_VETO: "NoWithVeto",
  };
  return mapping[option] || option;
}

function getVoteEmoji(option: string): string {
  switch (option) {
    case "VOTE_OPTION_YES":
      return "\u2705\u2705\u2705"; // Green checkmarks
    case "VOTE_OPTION_NO":
      return "\u{1F6A8}\u{1F6A8}\u{1F6A8}\u26A0\uFE0F\u26A0\uFE0F\u26A0\uFE0F\u{1F6A8}\u{1F6A8}\u{1F6A8}"; // Red sirens and warnings
    case "VOTE_OPTION_ABSTAIN":
      return "\u{1F7E4}\u{1F7E4}\u{1F7E4}"; // Gray circles
    case "VOTE_OPTION_NO_WITH_VETO":
      return "\u{1F6A8}\u{1F6A8}\u{1F6A8}\u26A0\uFE0F\u26A0\uFE0F\u26A0\uFE0F\u274C\u274C\u274C"; // Sirens, warnings, and X marks
    default:
      return "\u2753"; // Question mark
  }
}

async function fetchDelegatorVotingPower(
  lcdUrl: string,
  delegatorAddress: string,
  totalStakedTokens: number
): Promise<number> {
  try {
    const url = new URL(`${lcdUrl}/cosmos/staking/v1beta1/delegations/${delegatorAddress}`);
    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return 0;
    }

    const data = await resp.json();
    const delegations = data.delegation_responses || [];

    let totalDelegated = 0;
    for (const delegation of delegations) {
      totalDelegated += parseInt(delegation.balance?.amount || "0", 10);
    }

    if (totalStakedTokens === 0) return 0;
    return (totalDelegated / totalStakedTokens) * 100;
  } catch {
    return 0;
  }
}

async function notifyWhaleVote(
  vote: Vote,
  proposalId: string,
  votingPowerPct: number,
  slackWebhook: string
): Promise<void> {
  const rawOption = vote.options?.[0]?.option || "UNKNOWN";
  const option = formatVoteOption(rawOption);
  const voteEmoji = getVoteEmoji(rawOption);
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const whaleEmoji = "\u{1F433}\u{1F433}\u{1F433}"; // Whale emojis
  const shortVoter = vote.voter.length > 20
    ? `${vote.voter.slice(0, 12)}...${vote.voter.slice(-6)}`
    : vote.voter;

  const message = `${whaleEmoji} *WHALE ALERT* ${whaleEmoji}\n${voteEmoji} ${shortVoter} (${votingPowerPct.toFixed(2)}% VP) votes ${option} on proposal ${proposalId} at ${timestamp}`;

  const resp = await fetch(slackWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`Failed to post to Slack: ${resp.status} ${resp.statusText}`);
  }
}

async function postErrorToSlack(webhook: string, errorMessage: string): Promise<void> {
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `:warning: Gov notification bot error: ${errorMessage}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Don't throw if error notification fails
  }
}
