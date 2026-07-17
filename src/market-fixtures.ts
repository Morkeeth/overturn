// What can this escrow be pointed at? Reads TxLINE, so it is never a stale list.
import { fixtures, line, rule } from './market.js';

const all = await fixtures();
const now = Date.now();

rule();
line('  WORLD CUP FIXTURES · from TxLINE');
rule();
for (const f of all) {
  const t = new Date(f.startTime).toISOString().replace('T', ' ').slice(0, 16);
  const state = f.finished ? 'played ' : f.startTime > now ? 'UPCOMING' : 'in play';
  const away = f.startTime > now ? `  (kicks off in ${((f.startTime - now) / 3600000).toFixed(1)}h)` : '';
  line(`  ${state}  ${t} UTC  ${String(f.fixtureId).padEnd(9)} ${f.home} v ${f.away}${away}`);
}
line('');
line('  Open a market on one:  npm run market:open -- --fixture <id> --stat 1 --threshold 1');
line('  stat 1 = home goals, stat 2 = away goals. The prop binds to period 100 (full time).');
