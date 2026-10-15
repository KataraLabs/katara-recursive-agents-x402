/** @module Print the new public wallet address while keeping the generated key in an ignored owner-only file. */
import { createWallet } from '../src/wallet.js';
import { errorCode } from '../src/types.js';
try { console.log(`Created ignored .env for ${createWallet()}, set to Test. Run npm run faucet next.`); }
catch (e) { console.error(errorCode(e)); process.exitCode = 1; }
