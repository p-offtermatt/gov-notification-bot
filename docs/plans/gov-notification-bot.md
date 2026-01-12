# Cosmos Hub Governance Vote Notification Bot

A Python serverless bot that monitors Cosmos Hub validator votes on specified governance proposals and posts notifications to Slack.

## Overview

- **Runtime**: Python on Netlify Functions
- **Trigger**: Scheduled every 1 minute via Netlify Scheduled Functions
- **Data Source**: Cosmos Hub LCD REST API (configurable endpoint)
- **State Persistence**: Netlify Blobs (tracks notified votes to avoid duplicates)
- **Notifications**: Slack Incoming Webhook

## Notification Format

```
Informal Systems (5.2% VP) votes Yes on proposal 1022 at 2024-01-15 14:30 UTC
```

Components:
- Validator moniker (fetched from staking endpoint)
- Voting power percentage
- Vote option (Yes/No/Abstain/NoWithVeto)
- Proposal ID
- UTC timestamp of the vote

## Architecture

```
┌─────────────────────┐
│  Netlify Scheduler  │
│   (every 1 minute)  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   Python Function   │
│  (gov-vote-notify)  │
└──────────┬──────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
┌─────────┐  ┌─────────────┐
│ Cosmos  │  │  Netlify    │
│ Hub LCD │  │  Blobs      │
└─────────┘  │ (seen votes)│
             └─────────────┘
           │
           ▼
┌─────────────────────┐
│   Slack Webhook     │
│  (notifications)    │
└─────────────────────┘
```

## Implementation Steps

### 1. Project Setup

Create the Netlify Functions project structure:

```
gov-notification-bot/
├── netlify/
│   └── functions/
│       └── gov-vote-notify/
│           ├── gov-vote-notify.py
│           └── requirements.txt
├── netlify.toml
├── .env.example
└── README.md
```

### 2. Environment Variables

Configure in Netlify dashboard under Site Settings → Environment Variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `COSMOS_LCD_URL` | Cosmos Hub LCD endpoint | `https://cosmos-lcd.publicnode.com` |
| `PROPOSAL_IDS` | Comma-separated proposal IDs to track | `1022` or `1022,1023` |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for notifications | `https://hooks.slack.com/services/...` |
| `SLACK_ERROR_WEBHOOK_URL` | Slack webhook for error alerts | `https://hooks.slack.com/services/...` |

### 3. Core Function Logic

```python
# netlify/functions/gov-vote-notify/gov-vote-notify.py

import os
import json
import requests
from datetime import datetime
from netlify_blobs import get_store

def handler(event, context):
    """Scheduled function that runs every 1 minute."""

    lcd_url = os.environ["COSMOS_LCD_URL"]
    proposal_ids = os.environ["PROPOSAL_IDS"].split(",")
    slack_webhook = os.environ["SLACK_WEBHOOK_URL"]
    error_webhook = os.environ.get("SLACK_ERROR_WEBHOOK_URL")

    store = get_store("gov-votes")

    try:
        for proposal_id in proposal_ids:
            process_proposal(proposal_id.strip(), lcd_url, store, slack_webhook)
        return {"statusCode": 200}
    except Exception as e:
        if error_webhook:
            post_error_to_slack(error_webhook, str(e))
        raise

def process_proposal(proposal_id, lcd_url, store, slack_webhook):
    """Fetch votes for a proposal and notify on new ones."""

    # Get all votes for the proposal
    votes = fetch_all_votes(lcd_url, proposal_id)

    # Get validators for moniker + voting power lookup
    validators = fetch_validators(lcd_url)

    # Load previously seen votes
    seen_key = f"seen_votes_{proposal_id}"
    seen_votes = json.loads(store.get(seen_key) or "{}")

    new_votes = []
    for vote in votes:
        voter = vote["voter"]
        if voter not in seen_votes:
            new_votes.append(vote)
            seen_votes[voter] = {
                "option": vote["options"][0]["option"],
                "timestamp": datetime.utcnow().isoformat()
            }

    # Notify for each new vote
    for vote in new_votes:
        notify_vote(vote, proposal_id, validators, slack_webhook)

    # Persist updated seen votes
    store.set(seen_key, json.dumps(seen_votes))

def fetch_all_votes(lcd_url, proposal_id):
    """Fetch all votes with pagination."""
    votes = []
    pagination_key = None

    while True:
        url = f"{lcd_url}/cosmos/gov/v1/proposals/{proposal_id}/votes"
        params = {"pagination.limit": 100}
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
    """Fetch all validators with their monikers and voting power."""
    validators = {}
    pagination_key = None
    total_power = 0

    while True:
        url = f"{lcd_url}/cosmos/staking/v1beta1/validators"
        params = {"pagination.limit": 100, "status": "BOND_STATUS_BONDED"}
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
                "tokens": tokens
            }

        pagination_key = data.get("pagination", {}).get("next_key")
        if not pagination_key:
            break

    # Calculate voting power percentages
    for v in validators.values():
        v["voting_power_pct"] = (v["tokens"] / total_power) * 100 if total_power > 0 else 0

    return validators

def get_validator_account(lcd_url, operator_address):
    """Convert operator address to account address for vote matching."""
    # Votes are cast by account addresses, need to map from operator
    # This requires querying the validator's delegator address
    url = f"{lcd_url}/cosmos/staking/v1beta1/validators/{operator_address}"
    resp = requests.get(url, timeout=30)
    if resp.status_code == 200:
        # Extract account address from validator info or derive from operator
        pass
    return None

def notify_vote(vote, proposal_id, validators, slack_webhook):
    """Post vote notification to Slack."""
    voter = vote["voter"]
    option = format_vote_option(vote["options"][0]["option"])
    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

    # Find validator info (voter may be account address, need mapping)
    validator_info = find_validator_by_account(voter, validators)

    if validator_info:
        moniker = validator_info["moniker"]
        vp = validator_info["voting_power_pct"]
        message = f"{moniker} ({vp:.1f}% VP) votes {option} on proposal {proposal_id} at {timestamp}"
    else:
        # Not a validator vote, or couldn't find mapping
        message = f"{voter[:12]}...{voter[-6:]} votes {option} on proposal {proposal_id} at {timestamp}"

    requests.post(slack_webhook, json={"text": message}, timeout=10)

def format_vote_option(option):
    """Convert vote option enum to human readable."""
    mapping = {
        "VOTE_OPTION_YES": "Yes",
        "VOTE_OPTION_NO": "No",
        "VOTE_OPTION_ABSTAIN": "Abstain",
        "VOTE_OPTION_NO_WITH_VETO": "NoWithVeto",
    }
    return mapping.get(option, option)

def find_validator_by_account(account_address, validators):
    """Find validator info by their account address."""
    # Note: This requires maintaining a mapping between validator operator
    # addresses and their self-delegation/signing addresses
    # Implementation depends on how votes are indexed
    # May need to pre-build this mapping from validator set
    pass

def post_error_to_slack(webhook, error_message):
    """Post error to error notification channel."""
    requests.post(webhook, json={
        "text": f":warning: Gov notification bot error: {error_message}"
    }, timeout=10)
```

### 4. Requirements File

```txt
# netlify/functions/gov-vote-notify/requirements.txt
requests>=2.28.0
```

### 5. Netlify Configuration

```toml
# netlify.toml

[build]
  command = "echo 'No build required'"
  publish = "."

[functions]
  directory = "netlify/functions"

[[functions.gov-vote-notify]]
  schedule = "* * * * *"  # Every minute
```

### 6. Validator Address Mapping

The Cosmos Hub uses different address formats:
- **Operator address**: `cosmosvaloper1...` (validator identity)
- **Account address**: `cosmos1...` (where votes come from)

The bot needs to map between these. Options:

**Option A**: Query each validator's self-delegation address at startup and cache it.

**Option B**: Use an indexer API that provides this mapping (e.g., Mintscan API if available).

**Option C**: Derive the account address from the operator address (they share the same underlying key, just different bech32 prefixes).

Recommended approach (Option C):
```python
import bech32

def operator_to_account(operator_address):
    """Convert cosmosvaloper1... to cosmos1..."""
    hrp, data = bech32.bech32_decode(operator_address)
    if hrp == "cosmosvaloper":
        return bech32.bech32_encode("cosmos", data)
    return None
```

Add `bech32` to requirements.txt.

## Deployment Steps

### 1. Create Slack Incoming Webhooks

1. Go to https://api.slack.com/apps
2. Create a new app (or use existing) → "From scratch"
3. Select your workspace
4. Go to "Incoming Webhooks" → Enable
5. Click "Add New Webhook to Workspace"
6. Select the channel for vote notifications (e.g., `#governance`)
7. Copy the webhook URL
8. Repeat for error notifications channel (e.g., `#alerts`)

### 2. Set Up Netlify Project

1. Create a new Git repository with the project structure above
2. Push to GitHub/GitLab
3. Go to https://app.netlify.com
4. Click "Add new site" → "Import an existing project"
5. Connect your repository
6. Configure build settings (auto-detected from netlify.toml)
7. Add environment variables:
   - `COSMOS_LCD_URL`: Your preferred LCD endpoint
   - `PROPOSAL_IDS`: `1022` (or comma-separated list)
   - `SLACK_WEBHOOK_URL`: Webhook URL from step 1
   - `SLACK_ERROR_WEBHOOK_URL`: Error webhook URL
8. Deploy

### 3. Verify Deployment

1. Check Netlify Functions logs: Site dashboard → Functions → gov-vote-notify
2. Verify the function is being invoked every minute
3. Test by checking if existing votes trigger notifications (on first run, all current votes will be "new")

### 4. Production Considerations

**Rate Limits**: If tracking multiple proposals or high-volume voting periods, consider:
- Increasing poll interval to 2-5 minutes
- Using a dedicated RPC/LCD node
- Implementing exponential backoff on API errors

**Netlify Blobs Limits**: Free tier includes 100GB bandwidth and 5GB storage per month. State files are small (< 1MB typically).

**Function Timeout**: Netlify Functions have a 10-second timeout on free tier, 26 seconds on Pro. If fetching many pages of votes, may need Pro plan or optimize queries.

## Monitoring

### Logs

View function execution logs in Netlify dashboard:
- Site dashboard → Functions → gov-vote-notify → View logs

### Alerts

The error webhook will notify on:
- LCD API failures (connection errors, timeouts)
- Slack webhook failures
- Unexpected exceptions

### Metrics

Monitor via Netlify Analytics:
- Function invocation count
- Average execution time
- Error rate

## Extending the Bot

### Adding More Proposals

Update the `PROPOSAL_IDS` environment variable with comma-separated values:
```
PROPOSAL_IDS=1022,1025,1030
```

### Adding Vote Type Filters

Modify `notify_vote()` to filter by vote option if you only want to track specific vote types.

### Multiple Slack Channels

Add logic to route different proposals to different webhooks:
```python
PROPOSAL_WEBHOOKS = {
    "1022": os.environ["SLACK_WEBHOOK_PROP_1022"],
    "default": os.environ["SLACK_WEBHOOK_URL"],
}
```

## Cost Estimate

**Netlify Free Tier**:
- 125,000 function invocations/month (1/minute = 43,200/month) ✓
- 100GB bandwidth ✓
- Netlify Blobs included ✓

**Total Cost**: $0/month for basic usage.

If higher reliability or longer timeouts needed, Netlify Pro is $19/month.
