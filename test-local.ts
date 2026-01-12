/**
 * Local test script for the governance vote notification bot.
 * Run with: npx tsx test-local.ts
 */

import { bech32 } from "bech32";

interface Vote {
  voter: string;
  options: Array<{ option: string; weight: string }>;
}

interface ValidatorInfo {
  moniker: string;
  tokens: number;
  operatorAddress: string;
  votingPowerPct: number;
}

const LCD_URL = "https://cosmos-lcd.publicnode.com";
const PROPOSAL_ID = process.env.PROPOSAL_IDS?.split(",")[0] || "1022";

async function fetchAllVotes(proposalId: string): Promise<Vote[]> {
  const votes: Vote[] = [];
  let paginationKey: string | null = null;

  while (true) {
    const url = new URL(`${LCD_URL}/cosmos/gov/v1/proposals/${proposalId}/votes`);
    url.searchParams.set("pagination.limit", "100");
    if (paginationKey) {
      url.searchParams.set("pagination.key", paginationKey);
    }

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      throw new Error(`Failed to fetch votes: ${resp.status}`);
    }

    const data = await resp.json();
    votes.push(...(data.votes || []));
    paginationKey = data.pagination?.next_key || null;

    if (!paginationKey) break;
  }

  return votes;
}

async function fetchValidators(): Promise<Map<string, ValidatorInfo>> {
  const validators = new Map<string, ValidatorInfo>();
  let paginationKey: string | null = null;
  let totalPower = 0;
  const validatorList: Array<{ address: string; info: ValidatorInfo }> = [];

  while (true) {
    const url = new URL(`${LCD_URL}/cosmos/staking/v1beta1/validators`);
    url.searchParams.set("pagination.limit", "100");
    url.searchParams.set("status", "BOND_STATUS_BONDED");
    if (paginationKey) {
      url.searchParams.set("pagination.key", paginationKey);
    }

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      throw new Error(`Failed to fetch validators: ${resp.status}`);
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
          votingPowerPct: 0,
        },
      });
    }

    paginationKey = data.pagination?.next_key || null;
    if (!paginationKey) break;
  }

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
    return null;
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

function formatVoteOption(option: string): string {
  const mapping: Record<string, string> = {
    VOTE_OPTION_YES: "Yes",
    VOTE_OPTION_NO: "No",
    VOTE_OPTION_ABSTAIN: "Abstain",
    VOTE_OPTION_NO_WITH_VETO: "NoWithVeto",
  };
  return mapping[option] || option;
}

async function main() {
  console.log(`\n=== Testing Proposal ${PROPOSAL_ID} ===\n`);

  console.log("Fetching votes...");
  const votes = await fetchAllVotes(PROPOSAL_ID);
  console.log(`Total votes: ${votes.length}`);

  console.log("Fetching validators...");
  const validators = await fetchValidators();
  console.log(`Total bonded validators: ${validators.size}`);

  const validatorByAccount = buildAccountToValidatorMapping(validators);

  // Find validator votes
  const validatorVotes: Array<{ vote: Vote; info: ValidatorInfo }> = [];
  for (const vote of votes) {
    const info = validatorByAccount.get(vote.voter);
    if (info) {
      validatorVotes.push({ vote, info });
    }
  }

  console.log(`\nValidator votes found: ${validatorVotes.length}`);
  console.log("\n--- Sample Notification Messages ---\n");

  for (const { vote, info } of validatorVotes.slice(0, 10)) {
    const option = formatVoteOption(vote.options?.[0]?.option || "UNKNOWN");
    const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const message = `${info.moniker} (${info.votingPowerPct.toFixed(1)}% VP) votes ${option} on proposal ${PROPOSAL_ID} at ${timestamp}`;
    console.log(message);
  }

  if (validatorVotes.length > 10) {
    console.log(`\n... and ${validatorVotes.length - 10} more validator votes`);
  }

  console.log("\n=== Test Complete ===\n");
}

main().catch(console.error);
