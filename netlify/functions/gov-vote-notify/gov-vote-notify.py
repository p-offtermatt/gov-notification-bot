"""
Cosmos Hub Governance Vote Notification Bot

A serverless function that monitors Cosmos Hub validator votes on specified
governance proposals and posts notifications to Slack.
"""

import os
import json
import requests
from datetime import datetime, timezone
import bech32


def handler(event, context):
    """Scheduled function that runs every 1 minute."""
    lcd_url = os.environ.get("COSMOS_LCD_URL", "https://cosmos-lcd.publicnode.com")
    proposal_ids = os.environ.get("PROPOSAL_IDS", "").split(",")
    slack_webhook = os.environ.get("SLACK_WEBHOOK_URL")
    error_webhook = os.environ.get("SLACK_ERROR_WEBHOOK_URL")

    if not proposal_ids or not proposal_ids[0]:
        return {"statusCode": 400, "body": "PROPOSAL_IDS not configured"}

    if not slack_webhook:
        return {"statusCode": 400, "body": "SLACK_WEBHOOK_URL not configured"}

    # Use in-memory store for local testing, Netlify Blobs in production
    store = get_store()

    try:
        for proposal_id in proposal_ids:
            proposal_id = proposal_id.strip()
            if proposal_id:
                process_proposal(proposal_id, lcd_url, store, slack_webhook)
        return {"statusCode": 200, "body": "OK"}
    except Exception as e:
        if error_webhook:
            post_error_to_slack(error_webhook, str(e))
        raise


def get_store():
    """Get appropriate storage backend based on environment."""
    try:
        from netlify_blobs import get_store as get_netlify_store
        return NetlifyBlobStore(get_netlify_store("gov-votes"))
    except ImportError:
        # Fall back to file-based storage for local testing
        return FileStore()


class NetlifyBlobStore:
    """Wrapper for Netlify Blobs storage."""

    def __init__(self, store):
        self.store = store

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value):
        self.store.set(key, value)


class FileStore:
    """File-based storage for local testing."""

    def __init__(self, storage_dir=None):
        if storage_dir is None:
            storage_dir = os.path.join(os.path.dirname(__file__), ".store")
        self.storage_dir = storage_dir
        os.makedirs(self.storage_dir, exist_ok=True)

    def _get_path(self, key):
        # Sanitize key for filesystem
        safe_key = key.replace("/", "_").replace("\\", "_")
        return os.path.join(self.storage_dir, f"{safe_key}.json")

    def get(self, key):
        path = self._get_path(key)
        if os.path.exists(path):
            with open(path, "r") as f:
                return f.read()
        return None

    def set(self, key, value):
        path = self._get_path(key)
        with open(path, "w") as f:
            f.write(value)


def process_proposal(proposal_id, lcd_url, store, slack_webhook):
    """Fetch votes for a proposal and notify on new ones."""
    # Get all votes for the proposal
    votes = fetch_all_votes(lcd_url, proposal_id)

    # Get validators for moniker + voting power lookup
    validators = fetch_validators(lcd_url)

    # Build mapping from account addresses to validator info
    validator_by_account = build_account_to_validator_mapping(validators)

    # Load previously seen votes
    seen_key = f"seen_votes_{proposal_id}"
    seen_data = store.get(seen_key)
    seen_votes = json.loads(seen_data) if seen_data else {}

    new_votes = []
    for vote in votes:
        voter = vote["voter"]
        if voter not in seen_votes:
            new_votes.append(vote)
            seen_votes[voter] = {
                "option": vote["options"][0]["option"] if vote.get("options") else "UNKNOWN",
                "timestamp": datetime.now(timezone.utc).isoformat()
            }

    # Notify for each new vote
    for vote in new_votes:
        notify_vote(vote, proposal_id, validator_by_account, slack_webhook)

    # Persist updated seen votes
    store.set(seen_key, json.dumps(seen_votes))

    return len(new_votes)


def fetch_all_votes(lcd_url, proposal_id):
    """Fetch all votes with pagination."""
    votes = []
    pagination_key = None

    while True:
        url = f"{lcd_url}/cosmos/gov/v1/proposals/{proposal_id}/votes"
        params = {"pagination.limit": "100"}
        if pagination_key:
            params["pagination.key"] = pagination_key

        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        votes.extend(data.get("votes", []))
        pagination_key = data.get("pagination", {}).get("next_key")

        if not pagination_key:
            break

    return votes


def fetch_validators(lcd_url):
    """Fetch all bonded validators with their monikers and voting power."""
    validators = {}
    pagination_key = None
    total_power = 0

    while True:
        url = f"{lcd_url}/cosmos/staking/v1beta1/validators"
        params = {"pagination.limit": "100", "status": "BOND_STATUS_BONDED"}
        if pagination_key:
            params["pagination.key"] = pagination_key

        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        for v in data.get("validators", []):
            tokens = int(v["tokens"])
            total_power += tokens
            validators[v["operator_address"]] = {
                "moniker": v["description"]["moniker"],
                "tokens": tokens,
                "operator_address": v["operator_address"]
            }

        pagination_key = data.get("pagination", {}).get("next_key")
        if not pagination_key:
            break

    # Calculate voting power percentages
    for v in validators.values():
        v["voting_power_pct"] = (v["tokens"] / total_power) * 100 if total_power > 0 else 0

    return validators


def operator_to_account(operator_address):
    """Convert cosmosvaloper1... to cosmos1... address."""
    try:
        hrp, data = bech32.bech32_decode(operator_address)
        if hrp == "cosmosvaloper":
            return bech32.bech32_encode("cosmos", data)
    except Exception:
        pass
    return None


def build_account_to_validator_mapping(validators):
    """Build a mapping from account addresses to validator info."""
    mapping = {}
    for operator_address, info in validators.items():
        account_address = operator_to_account(operator_address)
        if account_address:
            mapping[account_address] = info
    return mapping


def notify_vote(vote, proposal_id, validator_by_account, slack_webhook):
    """Post vote notification to Slack."""
    voter = vote["voter"]
    options = vote.get("options", [])

    if options:
        option = format_vote_option(options[0]["option"])
    else:
        option = "Unknown"

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    # Find validator info
    validator_info = validator_by_account.get(voter)

    if validator_info:
        moniker = validator_info["moniker"]
        vp = validator_info["voting_power_pct"]
        message = f"{moniker} ({vp:.1f}% VP) votes {option} on proposal {proposal_id} at {timestamp}"
    else:
        # Not a validator vote, or couldn't find mapping
        short_voter = f"{voter[:12]}...{voter[-6:]}" if len(voter) > 20 else voter
        message = f"{short_voter} votes {option} on proposal {proposal_id} at {timestamp}"

    response = requests.post(slack_webhook, json={"text": message}, timeout=10)
    response.raise_for_status()


def format_vote_option(option):
    """Convert vote option enum to human readable."""
    mapping = {
        "VOTE_OPTION_YES": "Yes",
        "VOTE_OPTION_NO": "No",
        "VOTE_OPTION_ABSTAIN": "Abstain",
        "VOTE_OPTION_NO_WITH_VETO": "NoWithVeto",
    }
    return mapping.get(option, option)


def post_error_to_slack(webhook, error_message):
    """Post error to error notification channel."""
    try:
        requests.post(webhook, json={
            "text": f":warning: Gov notification bot error: {error_message}"
        }, timeout=10)
    except Exception:
        # Don't raise if error notification fails
        pass


# For local testing
if __name__ == "__main__":
    import sys

    # Check if environment variables are set
    if not os.environ.get("COSMOS_LCD_URL"):
        os.environ["COSMOS_LCD_URL"] = "https://cosmos-lcd.publicnode.com"

    if not os.environ.get("PROPOSAL_IDS"):
        print("Please set PROPOSAL_IDS environment variable (e.g., export PROPOSAL_IDS=1022)")
        sys.exit(1)

    dry_run = "--dry-run" in sys.argv

    if dry_run:
        print("Running in dry-run mode (no Slack notifications)")

        # Test fetching data
        lcd_url = os.environ["COSMOS_LCD_URL"]
        proposal_ids = os.environ["PROPOSAL_IDS"].split(",")

        for proposal_id in proposal_ids:
            proposal_id = proposal_id.strip()
            if not proposal_id:
                continue

            print(f"\n=== Proposal {proposal_id} ===")

            try:
                votes = fetch_all_votes(lcd_url, proposal_id)
                print(f"Total votes: {len(votes)}")

                validators = fetch_validators(lcd_url)
                print(f"Total bonded validators: {len(validators)}")

                validator_by_account = build_account_to_validator_mapping(validators)

                # Show first few votes
                print("\nSample votes:")
                for i, vote in enumerate(votes[:5]):
                    voter = vote["voter"]
                    options = vote.get("options", [])
                    option = format_vote_option(options[0]["option"]) if options else "Unknown"

                    validator_info = validator_by_account.get(voter)
                    if validator_info:
                        print(f"  {validator_info['moniker']} ({validator_info['voting_power_pct']:.2f}% VP): {option}")
                    else:
                        short_voter = f"{voter[:12]}...{voter[-6:]}" if len(voter) > 20 else voter
                        print(f"  {short_voter}: {option}")

                if len(votes) > 5:
                    print(f"  ... and {len(votes) - 5} more votes")

            except Exception as e:
                print(f"Error processing proposal {proposal_id}: {e}")
    else:
        if not os.environ.get("SLACK_WEBHOOK_URL"):
            print("Please set SLACK_WEBHOOK_URL environment variable for live mode")
            print("Or use --dry-run for testing without Slack")
            sys.exit(1)

        result = handler({}, {})
        print(f"Result: {result}")
