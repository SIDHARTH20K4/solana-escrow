import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { Vault } from "../target/types/vault";

describe("vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Vault as Program<Vault>;
  const owner = provider.wallet as anchor.Wallet;

  const getVaultPda = (ownerPubkey: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), ownerPubkey.toBuffer()],
      program.programId
    );

  it("deposits and creates vault", async () => {
    const [vaultPda] = getVaultPda(owner.publicKey);
    const depositAmount = new anchor.BN(1_000_000_000); // 1 SOL

    const balBefore = await provider.connection.getBalance(owner.publicKey);

    await program.methods
      .deposit(depositAmount)
      .accounts({
  owner: owner.publicKey,
})
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(vaultAccount.owner.toBase58(), owner.publicKey.toBase58());

    const vaultLamports = await provider.connection.getBalance(vaultPda);
    assert.isAtLeast(vaultLamports, depositAmount.toNumber());

    const balAfter = await provider.connection.getBalance(owner.publicKey);
    assert.isBelow(balAfter, balBefore);
  });

  it("withdraws lamports back to owner", async () => {
    const [vaultPda] = getVaultPda(owner.publicKey);
    const withdrawAmount = new anchor.BN(500_000_000); // 0.5 SOL

    const vaultBefore = await provider.connection.getBalance(vaultPda);
    const ownerBefore = await provider.connection.getBalance(owner.publicKey);

    await program.methods
      .withdraw(withdrawAmount)
      .accounts({
  owner: owner.publicKey,
})
      .rpc();

    const vaultAfter = await provider.connection.getBalance(vaultPda);
    const ownerAfter = await provider.connection.getBalance(owner.publicKey);

    assert.strictEqual(vaultBefore - vaultAfter, withdrawAmount.toNumber());
    assert.isAbove(ownerAfter, ownerBefore);
  });

  it("fails to withdraw more than vault holds", async () => {
    try {
      await program.methods
        .withdraw(new anchor.BN(999_000_000_000))
        .accounts({
          owner: owner.publicKey,
        })
        .rpc();
      assert.fail("expected withdraw to fail");
    } catch (err) {
      assert.exists(err);
    }
  });

  it("closes vault and returns all lamports", async () => {
    const [vaultPda] = getVaultPda(owner.publicKey);

    const vaultLamportsBefore = await provider.connection.getBalance(vaultPda);
    const ownerBefore = await provider.connection.getBalance(owner.publicKey);

    await program.methods
      .close()
      .accounts({
        owner: owner.publicKey,
      })
      .rpc();

    const vaultAccountInfo = await provider.connection.getAccountInfo(vaultPda);
    assert.isNull(vaultAccountInfo);

    const ownerAfter = await provider.connection.getBalance(owner.publicKey);
    assert.isAbove(ownerAfter, ownerBefore + vaultLamportsBefore - 10_000_000);
  });
});