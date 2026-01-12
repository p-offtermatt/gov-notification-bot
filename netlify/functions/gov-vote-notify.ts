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

  // Load previously seen votes
  const seenKey = `seen_votes_${proposalId}`;
  let seenVotes: SeenVotes = {};
  try {
    const seenData = await store.get(seenKey);
    if (seenData) {
      seenVotes = JSON.parse(seenData);
    }
  } catch {
    // No existing data, start fresh
  }

  const newVotes: Vote[] = [];
  for (const vote of votes) {
    if (!(vote.voter in seenVotes)) {
      newVotes.push(vote);
      seenVotes[vote.voter] = {
        option: vote.options?.[0]?.option || "UNKNOWN",
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Notify for each new vote
  for (const vote of newVotes) {
    await notifyVote(vote, proposalId, validatorByAccount, slackWebhook);
  }

  // Persist updated seen votes
  await store.set(seenKey, JSON.stringify(seenVotes));

  return newVotes.length;
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
  validatorByAccount: Map<string, ValidatorInfo>,
  slackWebhook: string
): Promise<void> {
  const voter = vote.voter;
  const option = formatVoteOption(vote.options?.[0]?.option || "UNKNOWN");
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const validatorInfo = validatorByAccount.get(voter);
  let message: string;

  if (validatorInfo) {
    const { moniker, votingPowerPct } = validatorInfo;
    message = `${moniker} (${votingPowerPct.toFixed(1)}% VP) votes ${option} on proposal ${proposalId} at ${timestamp}`;
  } else {
    const shortVoter =
      voter.length > 20 ? `${voter.slice(0, 12)}...${voter.slice(-6)}` : voter;
    message = `${shortVoter} votes ${option} on proposal ${proposalId} at ${timestamp}`;
  }

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
