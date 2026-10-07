const { Keypair } = require('@solana/web3.js');
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const file = join(root, 'target/deploy/content_rights_protocol-keypair.json');
mkdirSync(join(root, 'target/deploy'), { recursive: true });
if (!existsSync(file)) writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')))).publicKey.toBase58();
for (const relative of ['programs/content_rights_protocol/src/lib.rs', 'Anchor.toml', 'packages/protocol-sdk/src/index.ts']) {
  const path = join(root, relative);
  const source = readFileSync(path, 'utf8');
  const pattern = relative.endsWith('lib.rs') ? /declare_id!\("[1-9A-HJ-NP-Za-km-z]+"\)/
    : relative.endsWith('Anchor.toml') ? /content_rights_protocol = "[1-9A-HJ-NP-Za-km-z]+"/
    : /new PublicKey\('[1-9A-HJ-NP-Za-km-z]+'\)/;
  const replacement = relative.endsWith('lib.rs') ? `declare_id!("${id}")`
    : relative.endsWith('Anchor.toml') ? `content_rights_protocol = "${id}"` : `new PublicKey('${id}')`;
  if (!pattern.test(source)) throw new Error('Program ID pattern missing: ' + relative);
  writeFileSync(path, source.replace(pattern, replacement));
}
console.log('Local program address synchronized: ' + id + '. Rebuild SBF, IDL and TypeScript before local deployment.');
