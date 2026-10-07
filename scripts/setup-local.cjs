const { Keypair } = require('@solana/web3.js');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const dir = join(__dirname, '..', 'target', 'local-authorities');
mkdirSync(dir, { recursive: true });
for (const role of ['admin', 'originality', 'rights', 'treasury']) {
  const file = join(dir, role + '.json');
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
}
console.log('Local authority files prepared in target/local-authorities. Existing keys preserved.');
