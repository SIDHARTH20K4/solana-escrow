import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";
import { SolanaEscrow } from "../target/types/solana_escrow";

describe("solana-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaEscrow as Program<SolanaEscrow>;
  const connection = provider.connection;

  const maker = (provider.wallet as anchor.Wallet).payer;
  const taker = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let makerAtaA: PublicKey;
  let takerAtaB: PublicKey;

  const seed = new anchor.BN(1);
  const depositAmount = new anchor.BN(1_000_000);
  const receiveAmount = new anchor.BN(2_000_000);
  const decimals = 6;

  const getEscrowPda = (makerKey: PublicKey, seedBN: anchor.BN) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        makerKey.toBuffer(),
        seedBN.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

  before(async () => {
    const sig = await connection.requestAirdrop(taker.publicKey, 2_000_000_000);
    await connection.confirmTransaction(sig);

    mintA = await createMint(connection, maker, maker.publicKey, null, decimals);
    mintB = await createMint(connection, maker, maker.publicKey, null, decimals);

    makerAtaA = await createAssociatedTokenAccount(
      connection,
      maker,
      mintA,
      maker.publicKey
    );
    await mintTo(connection, maker, mintA, makerAtaA, maker, 10_000_000);

    takerAtaB = await createAssociatedTokenAccount(
      connection,
      taker,
      mintB,
      taker.publicKey
    );
    await mintTo(connection, maker, mintB, takerAtaB, maker, 10_000_000);
  });

  it("makes an escrow and deposits token A into the vault", async () => {
    const [escrowPda] = getEscrowPda(maker.publicKey, seed);
    const vault = getAssociatedTokenAddressSync(mintA, escrowPda, true);

    const expiration = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .make(seed, depositAmount, receiveAmount, expiration)
      .accounts({
        maker: maker.publicKey,
        mintA,
        mintB,
        makerAtaA,
        escrow: escrowPda,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const escrowAccount = await program.account.escrow.fetch(escrowPda);
    assert.strictEqual(
      escrowAccount.maker.toBase58(),
      maker.publicKey.toBase58()
    );
    assert.strictEqual(escrowAccount.mintA.toBase58(), mintA.toBase58());
    assert.strictEqual(escrowAccount.mintB.toBase58(), mintB.toBase58());
    assert.strictEqual(
      escrowAccount.receive.toString(),
      receiveAmount.toString()
    );

    const vaultAccount = await getAccount(connection, vault);
    assert.strictEqual(vaultAccount.amount.toString(), depositAmount.toString());
  });

  it("updates the receive amount", async () => {
    const [escrowPda] = getEscrowPda(maker.publicKey, seed);
    const newReceive = new anchor.BN(3_000_000);

    await program.methods
      .update(newReceive)
      .accounts({
        maker: maker.publicKey,
        mintA,
        mintB,
        escrow: escrowPda,
      })
      .signers([maker])
      .rpc();

    const escrowAccount = await program.account.escrow.fetch(escrowPda);
    assert.strictEqual(escrowAccount.receive.toString(), newReceive.toString());
  });

  it("fails to update with a zero receive amount", async () => {
    const [escrowPda] = getEscrowPda(maker.publicKey, seed);

    try {
      await program.methods
        .update(new anchor.BN(0))
        .accounts({
          maker: maker.publicKey,
          mintA,
          mintB,
          escrow: escrowPda,
        })
        .signers([maker])
        .rpc();
      assert.fail("expected update to fail with zero amount");
    } catch (err) {
      assert.exists(err);
    }
  });

  it("lets the taker complete the swap", async () => {
    const [escrowPda] = getEscrowPda(maker.publicKey, seed);
    const vault = getAssociatedTokenAddressSync(mintA, escrowPda, true);
    const takerAtaA = getAssociatedTokenAddressSync(mintA, taker.publicKey);
    const makerAtaB = getAssociatedTokenAddressSync(mintB, maker.publicKey);

    const escrowBefore = await program.account.escrow.fetch(escrowPda);

    await program.methods
      .take()
      .accounts({
        taker: taker.publicKey,
        maker: maker.publicKey,
        mintA,
        mintB,
        escrow: escrowPda,
        vault,
        takerAtaA,
        takerAtaB,
        makerAtaB,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    const takerAtaAInfo = await getAccount(connection, takerAtaA);
    assert.strictEqual(
      takerAtaAInfo.amount.toString(),
      depositAmount.toString()
    );

    const makerAtaBInfo = await getAccount(connection, makerAtaB);
    assert.strictEqual(
      makerAtaBInfo.amount.toString(),
      escrowBefore.receive.toString()
    );

    const vaultInfo = await connection.getAccountInfo(vault);
    assert.isNull(vaultInfo, "vault should be closed after take");

    const escrowInfo = await connection.getAccountInfo(escrowPda);
    assert.isNull(escrowInfo, "escrow should be closed after take");
  });

  it("lets the maker refund an un-taken escrow", async () => {
    const refundSeed = new anchor.BN(2);
    const [escrowPda] = getEscrowPda(maker.publicKey, refundSeed);
    const vault = getAssociatedTokenAddressSync(mintA, escrowPda, true);
    const expiration = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    await program.methods
      .make(refundSeed, depositAmount, receiveAmount, expiration)
      .accounts({
        maker: maker.publicKey,
        mintA,
        mintB,
        makerAtaA,
        escrow: escrowPda,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const makerAtaABefore = await getAccount(connection, makerAtaA);

    await program.methods
      .refund()
      .accounts({
        maker: maker.publicKey,
        mintA,
        escrow: escrowPda,
        vault,
        makerAtaA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    const makerAtaAAfter = await getAccount(connection, makerAtaA);
    assert.strictEqual(
      (makerAtaAAfter.amount - makerAtaABefore.amount).toString(),
      depositAmount.toString()
    );

    const vaultInfo = await connection.getAccountInfo(vault);
    assert.isNull(vaultInfo, "vault should be closed after refund");

    const escrowInfo = await connection.getAccountInfo(escrowPda);
    assert.isNull(escrowInfo, "escrow should be closed after refund");
  });
});