/**
 * USDC Payment Module for SnapAPI
 *
 * Monitors Polygon USDC transfers to the OpSpawn wallet.
 * Creates invoices with unique amounts for reconciliation.
 * Auto-generates API keys upon payment confirmation.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INVOICES_FILE = path.join(__dirname, 'invoices.json');
const WALLET_ADDRESS = '0x7483a9F237cf8043704D6b17DA31c12BfFF860DD';
const USDC_CONTRACT = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const POLYGON_RPC = 'https://polygon-rpc.com';

// USDC Transfer event signature: Transfer(address,address,uint256)
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Pricing (in USDC)
const PLANS = {
  pro: { price: 10.00, limit: 1000, name: 'Pro', period: 'month' },
  enterprise: { price: 50.00, limit: 10000, name: 'Enterprise', period: 'month' }
};

// Load invoices
let invoices = {};
try { invoices = JSON.parse(fs.readFileSync(INVOICES_FILE, 'utf8')); } catch {}

function saveInvoices() {
  fs.writeFileSync(INVOICES_FILE, JSON.stringify(invoices, null, 2));
}

/**
 * Create a payment invoice with a unique amount.
 * We add a small random offset (0.01-0.99 cents) to distinguish payers.
 */
function createInvoice(plan, email) {
  if (!PLANS[plan]) throw new Error(`Unknown plan: ${plan}`);

  const planData = PLANS[plan];
  const invoiceId = crypto.randomBytes(8).toString('hex');

  // Create a unique amount by adding cents offset based on invoice ID
  // This helps match payments to invoices when multiple are pending
  const offset = (parseInt(invoiceId.slice(0, 4), 16) % 99 + 1) / 100;
  const amount = planData.price + offset;

  // Round to 2 decimal places (USDC has 6 decimals, but we think in dollars)
  const roundedAmount = Math.round(amount * 100) / 100;

  invoices[invoiceId] = {
    id: invoiceId,
    plan,
    email: email || null,
    amount: roundedAmount,
    amount_raw: Math.round(roundedAmount * 1e6), // USDC has 6 decimals
    status: 'pending',
    wallet: WALLET_ADDRESS,
    network: 'Polygon',
    token: 'USDC',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour
    tx_hash: null,
    api_key: null
  };

  saveInvoices();
  return invoices[invoiceId];
}

/**
 * Check if an invoice has been paid by querying Polygon USDC Transfer events.
 */
async function checkPayment(invoiceId) {
  const invoice = invoices[invoiceId];
  if (!invoice) return null;
  if (invoice.status === 'paid') return invoice;

  // Check if expired
  if (new Date(invoice.expires_at) < new Date()) {
    invoice.status = 'expired';
    saveInvoices();
    return invoice;
  }

  // Query USDC Transfer events to our wallet
  try {
    const fromBlock = '0x' + Math.max(0, await getBlockNumber() - 5000).toString(16); // ~2.5 hours of blocks
    const toAddress = '0x' + WALLET_ADDRESS.slice(2).toLowerCase().padStart(64, '0');

    const response = await fetchRPC('eth_getLogs', [{
      fromBlock,
      toBlock: 'latest',
      address: USDC_CONTRACT,
      topics: [
        TRANSFER_TOPIC,
        null, // from (any)
        toAddress // to (our wallet)
      ]
    }]);

    if (response.result && Array.isArray(response.result)) {
      for (const log of response.result) {
        // Amount is in the data field (uint256, 6 decimals for USDC)
        const amountRaw = parseInt(log.data, 16);

        // Check if this matches our invoice amount (within 0.001 USDC tolerance)
        if (Math.abs(amountRaw - invoice.amount_raw) < 1000) {
          invoice.status = 'paid';
          invoice.tx_hash = log.transactionHash;
          invoice.paid_at = new Date().toISOString();

          // Generate API key
          const apiKey = 'pro_' + crypto.randomBytes(16).toString('hex');
          invoice.api_key = apiKey;

          saveInvoices();
          return invoice;
        }
      }
    }
  } catch (err) {
    console.error('Payment check error:', err.message);
  }

  return invoice;
}

/**
 * Get all invoices (for admin)
 */
function listInvoices() {
  return Object.values(invoices);
}

/**
 * Get current block number
 */
async function getBlockNumber() {
  const resp = await fetchRPC('eth_blockNumber', []);
  return parseInt(resp.result, 16);
}

/**
 * JSON-RPC call to Polygon
 */
async function fetchRPC(method, params) {
  const response = await fetch(POLYGON_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return response.json();
}

/**
 * Background poller - checks all pending invoices periodically
 */
let pollInterval = null;

function startPolling(intervalMs = 30000) {
  if (pollInterval) return;
  console.log(`Payment poller started (every ${intervalMs / 1000}s)`);

  pollInterval = setInterval(async () => {
    const pending = Object.values(invoices).filter(i => i.status === 'pending');
    if (pending.length === 0) return;

    console.log(`Checking ${pending.length} pending invoice(s)...`);
    for (const inv of pending) {
      await checkPayment(inv.id);
    }
  }, intervalMs);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

module.exports = {
  PLANS,
  WALLET_ADDRESS,
  createInvoice,
  checkPayment,
  listInvoices,
  startPolling,
  stopPolling
};
