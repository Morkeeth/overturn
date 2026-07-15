// One-shot: subscribe on-chain (free tier, real-time) + activate the API token.
// Reads the wallet from Keychain. Writes the API token back to Keychain. Nothing secret is printed.
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const RPC = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const API = 'https://txline.txodds.com';
const MINT = new PublicKey('Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL'); // TxL, Token-2022
const SERVICE_LEVEL = 12; // verified on-chain: price 0, sampling 0 => free AND real-time
const WEEKS = 4;          // program requires >=4 and %4==0
const LEAGUES = [];       // free tier = World Cup + Int'l Friendlies bundle

const kcGet = (s) => execFileSync('security', ['find-generic-password', '-a', 'worldcup-agent', '-s', s, '-w'], { encoding: 'utf8' }).trim();
const kcSet = (s, v) => execFileSync('security', ['add-generic-password', '-U', '-a', 'worldcup-agent', '-s', s, '-w', v]);

const user = Keypair.fromSecretKey(bs58.decode(kcGet('WC_WALLET_SECRET')));
const conn = new Connection(RPC, 'confirmed');
const idl = JSON.parse(fs.readFileSync('./idl.json', 'utf8'));
const programId = new PublicKey(idl.address);

console.log('wallet:', user.publicKey.toBase58());
console.log('balance:', (await conn.getBalance(user.publicKey)) / 1e9, 'SOL');

const wallet = new anchor.Wallet(user);
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: 'confirmed' });
const program = new anchor.Program(idl, provider);

const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from('pricing_matrix')], programId);
const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from('token_treasury_v2')], programId);
const tokenTreasuryVault = getAssociatedTokenAddressSync(MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);
const userTokenAccount = getAssociatedTokenAddressSync(MINT, user.publicKey, false, TOKEN_2022_PROGRAM_ID);

// 1. Token-2022 ATA (rent ~0.00204 SOL). Separate tx, per TxODDS' own example.
if (!(await conn.getAccountInfo(userTokenAccount))) {
  console.log('creating Token-2022 ATA...');
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      user.publicKey, userTokenAccount, user.publicKey, MINT,
      TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [user], { commitment: 'confirmed' });
  console.log('  ATA created:', sig);
  await new Promise((r) => setTimeout(r, 3000));
} else {
  console.log('ATA already exists');
}

// 2. Guest JWT
const jwt = await fetch(`${API}/auth/guest/start`, { method: 'POST' }).then((r) => r.json()).then((d) => d.token);
console.log('jwt:', jwt.length, 'chars');

// 3. subscribe(service_level_id: u16, weeks: u8)
console.log(`subscribing: level ${SERVICE_LEVEL}, ${WEEKS} weeks...`);
const txSig = await program.methods
  .subscribe(SERVICE_LEVEL, WEEKS)
  .accounts({
    user: user.publicKey,
    pricingMatrix: pricingMatrixPda,
    tokenMint: MINT,
    userTokenAccount,
    tokenTreasuryVault,
    tokenTreasuryPda,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: anchor.web3.SystemProgram.programId,
  })
  .signers([user])
  .rpc();
console.log('subscribed:', txSig);

// 4. Activation signature over `${txSig}:${leagues}:${jwt}` (empty leagues => double colon)
const message = `${txSig}:${LEAGUES.join(',')}:${jwt}`;
const walletSignature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), user.secretKey)).toString('base64');

// 5. Activate. Response is text/plain, not JSON.
const res = await fetch(`${API}/api/token/activate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ txSig, walletSignature, leagues: LEAGUES }),
});
const body = (await res.text()).trim();
if (!res.ok) { console.error('activate failed', res.status, body); process.exit(1); }

let apiToken = body;
try { apiToken = JSON.parse(body).token ?? body; } catch {}

kcSet('WC_API_TOKEN', apiToken);
kcSet('WC_JWT', jwt);
console.log('\nACTIVATED. api token stored in Keychain (%d chars, prefix %s...)', apiToken.length, apiToken.slice(0, 8));
