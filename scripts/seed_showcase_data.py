import sqlite3
import os
import sys
import json

db_path = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\ASUS\.gemini\antigravity\scratch\relaygate\data\relaygate.db'

conn = sqlite3.connect(db_path)
c = conn.cursor()

# 1. Insert Endpoints
endpoints = [
    ('ep_sample', 'Sample Stripe Webhook', 'whsec_sample_secret_key', 'https://billing.internal.net/v1/stripe/events', 'stripe', 1, '2026-11-07 09:55:00'),
    ('ep_stripe_billing', 'Stripe Billing Webhook', 'whsec_992a8f10c44a72d1', 'https://billing.internal.net/v1/stripe/events', 'stripe', 1, '2026-11-07 10:00:00'),
    ('ep_github_ci', 'GitHub Actions Ingress', 'ghsec_741c0b22a1f0983c', 'https://runner.internal.net/hooks/ci', 'github', 1, '2026-11-07 10:05:00'),
    ('ep_xendit_payout', 'Xendit Ledger Hook', 'xnd_token_510e4d89bc01', 'https://ledger.internal.net/xendit/callback', 'xendit', 1, '2026-11-07 10:10:00'),
    ('ep_shopify_orders', 'Shopify Fulfillment Ingress', 'shsec_309f1a77e810', 'https://fulfillment.internal.net/shopify/orders', 'shopify', 1, '2026-11-07 10:15:00')
]

for ep in endpoints:
    c.execute('''
        INSERT OR REPLACE INTO endpoints (id, name, secret_key, target_url, provider, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', ep)

# 2. Insert Webhook Events
events = [
    (
        'evt_992a8f10',
        'ep_stripe_billing',
        'stripe',
        '54.187.174.169',
        json.dumps({
            "Content-Type": "application/json",
            "Stripe-Signature": "t=1700000000,v1=992a8f10••••••••",
            "Authorization": "Bearer sec_live_••••••••",
            "User-Agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)"
        }),
        b'{"id":"evt_3Msw2CH8K91X92","object":"event","type":"invoice.payment_succeeded","data":{"object":{"id":"in_1Msw2CH8K91X92","amount_paid":4900,"currency":"usd","customer":"cus_N9wX7q8","status":"paid"}}}',
        't=1700000000,v1=992a8f10...',
        1,
        'DELIVERED',
        200,
        1,
        5,
        None,
        None,
        None,
        None,
        '2026-11-07 14:30:12',
        '2026-11-07 14:30:12'
    ),
    (
        'evt_741c0b22',
        'ep_github_ci',
        'github',
        '140.82.112.22',
        json.dumps({
            "Content-Type": "application/json",
            "X-Hub-Signature-256": "sha256=741c0b22••••••••",
            "X-GitHub-Event": "pull_request",
            "User-Agent": "GitHub-Hookshot/741c0b2"
        }),
        b'{"action":"opened","number":142,"pull_request":{"id":98214,"title":"feat(core): constant-time HMAC verifier","user":{"login":"octocat"}},"repository":{"full_name":"org/relaygate-core"}}',
        'sha256=741c0b22...',
        1,
        'DELIVERED',
        202,
        1,
        5,
        None,
        None,
        None,
        None,
        '2026-11-07 14:35:45',
        '2026-11-07 14:35:45'
    ),
    (
        'evt_510e4d89',
        'ep_xendit_payout',
        'xendit',
        '35.240.219.160',
        json.dumps({
            "Content-Type": "application/json",
            "x-callback-token": "xnd_token_••••••••",
            "User-Agent": "Xendit-Notifier/2.0"
        }),
        b'{"id":"disb_99214","status":"COMPLETED","amount":15000000,"external_id":"payroll_2026_11","bank_code":"BCA"}',
        'xnd_token_510e4d89...',
        1,
        'DELIVERED',
        200,
        1,
        5,
        None,
        None,
        None,
        None,
        '2026-11-07 14:42:10',
        '2026-11-07 14:42:10'
    ),
    (
        'evt_309f1a77',
        'ep_shopify_orders',
        'shopify',
        '23.227.38.64',
        json.dumps({
            "Content-Type": "application/json",
            "X-Shopify-Hmac-Sha256": "309f1a77••••••••",
            "X-Shopify-Topic": "orders/create"
        }),
        b'{"id":82098291194615,"order_number":1042,"total_price":"129.50","currency":"USD","financial_status":"paid"}',
        '309f1a77...',
        1,
        'DELIVERED',
        200,
        1,
        5,
        None,
        None,
        None,
        None,
        '2026-11-07 14:48:33',
        '2026-11-07 14:48:33'
    ),
    (
        'evt_499cd52a',
        'ep_stripe_billing',
        'stripe',
        '54.187.174.169',
        json.dumps({
            "Content-Type": "application/json",
            "Stripe-Signature": "t=1700001000,v1=499cd52a••••••••",
            "Authorization": "Bearer sec_live_••••••••"
        }),
        b'{"id":"evt_499cd52a","object":"event","type":"customer.subscription.created","data":{"subscription":"sub_99214","status":"active"}}',
        't=1700001000,v1=499cd52a...',
        1,
        'FAILED',
        504,
        5,
        5,
        'HTTP 504 Gateway Timeout: Downstream service internal.billing failed to respond within 5000ms budget',
        'ERR_DOWNSTREAM_5XX',
        '2026-11-07 14:55:00',
        None,
        '2026-11-07 14:50:00',
        '2026-11-07 14:55:00'
    ),
    (
        'evt_e10029c1',
        'ep_xendit_payout',
        'xendit',
        '35.240.219.160',
        json.dumps({
            "Content-Type": "application/json",
            "x-callback-token": "invalid_token_••••••••"
        }),
        b'{"id":"disb_bad","status":"PENDING"}',
        'invalid_token_...',
        -1,
        'FAILED',
        401,
        1,
        5,
        'xendit callback token mismatch',
        'ERR_SIGNATURE_MISMATCH',
        '2026-11-07 15:02:11',
        None,
        '2026-11-07 15:02:10',
        '2026-11-07 15:02:11'
    ),
    (
        'evt_32a5285c',
        'ep_github_ci',
        'github',
        '140.82.112.22',
        json.dumps({
            "Content-Type": "application/json"
        }),
        b'{"ref":"refs/heads/main"}',
        None,
        -1,
        'FAILED',
        400,
        1,
        5,
        'missing X-Hub-Signature-256 header',
        'ERR_SIGNATURE_MISSING',
        '2026-11-07 15:10:00',
        None,
        '2026-11-07 15:10:00',
        '2026-11-07 15:10:00'
    )
]

for ev in events:
    c.execute('''
        INSERT OR REPLACE INTO webhook_events (
            id, endpoint_id, provider, source_ip, headers, payload, signature,
            is_verified, status, http_status_code, attempts, max_attempts,
            last_error, failure_code, failed_at, next_retry_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', ev)

conn.commit()
print(f"Seeded {len(endpoints)} endpoints and {len(events)} webhook events.")
conn.close()
