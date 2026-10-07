const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { AnchorProvider, Program, Wallet } = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');

async function main() {
  const root = join(__dirname, '..');
  const key = role => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(root, 'target/local-authorities', role + '.json'), 'utf8'))));
  const admin = key('admin');
  const originality = key('originality').publicKey;
  const rights = key('rights').publicKey;
  const treasury = key('treasury').publicKey;
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: 'confirmed' });
  const program = new Program(JSON.parse(readFileSync(join(root, 'idl/content_rights_protocol.json'), 'utf8')), provider);
  const config = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId)[0];
  const existing = await connection.getAccountInfo(config);
  if (existing) {
    if (!existing.owner.equals(program.programId) || existing.executable) throw new Error('Invalid local config owner');
    const state = await program.account.protocolConfig.fetch(config);
    if (state.version !== 1 || !state.admin.equals(admin.publicKey) || !state.originalityAuthority.equals(originality)
      || !state.rightsAuthority.equals(rights) || !state.treasury.equals(treasury)) throw new Error('Existing local authorities do not match prepared keys');
    console.log('Local protocol already initialized with the prepared authorities.');
    return;
  }
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const programData = PublicKey.findProgramAddressSync([program.programId.toBuffer()], loader)[0];
  const signature = await program.methods.initializeProtocol(originality, rights, treasury).accountsStrict({
    admin: admin.publicKey, config, program: program.programId, programData, systemProgram: SystemProgram.programId,
  }).rpc();
  console.log('Local protocol initialized: ' + signature);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
