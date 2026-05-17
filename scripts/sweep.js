#!/usr/bin/env node
/*
 * EOA-side sweep deployer.
 *
 * Compiles contracts/Sweeper.sol, predicts the CREATE address it will deploy to,
 * lets you optionally pause to pre-fund that address, then sends the deploy tx.
 * Constructor moves everything held at the contract address into DESTINATION.
 *
 * Env:
 *   RPC_URL       JSON-RPC endpoint
 *   PRIVATE_KEY   deployer EOA (pays gas)
 *   DESTINATION   recipient EOA (assets land here); defaults to deployer
 *   ERC20S        comma-separated token addresses (optional)
 *   NFT721S       JSON: [{"token":"0x..","ids":["1","2"]}]      (optional)
 *   NFT1155S      JSON: [{"token":"0x..","ids":["1"],"amounts":["3"]}]  (optional)
 *   PREFUND_ETH   wei sent with the deploy tx so the contract holds it briefly
 *   PAUSE_MS      ms to wait between printing the predicted address and sending
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const solc = require("solc");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function compile() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "contracts", "Sweeper.sol"),
    "utf8"
  );
  const input = {
    language: "Solidity",
    sources: { "Sweeper.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const fatal = (out.errors || []).filter((e) => e.severity === "error");
  if (fatal.length) throw new Error(fatal.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["Sweeper.sol"].Sweeper;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(need("RPC_URL"));
  const wallet = new ethers.Wallet(need("PRIVATE_KEY"), provider);
  const deployer = await wallet.getAddress();
  const destination = ethers.getAddress(process.env.DESTINATION || deployer);

  const erc20s = (process.env.ERC20S || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(ethers.getAddress);
  const nft721s = JSON.parse(process.env.NFT721S || "[]");
  const nft1155s = JSON.parse(process.env.NFT1155S || "[]");
  const prefundEth = BigInt(process.env.PREFUND_ETH || "0");

  const { abi, bytecode } = compile();
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);

  const nonce = await provider.getTransactionCount(deployer, "pending");
  const predicted = ethers.getCreateAddress({ from: deployer, nonce });

  console.log("=== Sweeper deploy ===");
  console.log("deployer    :", deployer);
  console.log("destination :", destination);
  console.log("nonce       :", nonce);
  console.log("contract @  :", predicted, "  <-- pre-fund this address");
  console.log("erc20s      :", erc20s.length ? erc20s.join(", ") : "(none)");
  console.log("erc721s     :", nft721s.length, "collection(s)");
  console.log("erc1155s    :", nft1155s.length, "collection(s)");
  console.log("prefund eth :", prefundEth.toString(), "wei (sent with deploy)");

  const pause = Number(process.env.PAUSE_MS || "0");
  if (pause > 0) {
    console.log(`pausing ${pause}ms — fund ${predicted} now if you haven't…`);
    await new Promise((r) => setTimeout(r, pause));
  }

  const deployTx = await factory.getDeployTransaction(
    destination,
    erc20s,
    nft721s.map((n) => [ethers.getAddress(n.token), n.ids.map((x) => BigInt(x))]),
    nft1155s.map((n) => [
      ethers.getAddress(n.token),
      n.ids.map((x) => BigInt(x)),
      n.amounts.map((x) => BigInt(x)),
    ]),
    { value: prefundEth }
  );

  const sent = await wallet.sendTransaction({ ...deployTx, nonce });
  console.log("deploy tx   :", sent.hash);
  const receipt = await sent.wait();
  console.log("mined block :", receipt.blockNumber, "status:", receipt.status);
  if (receipt.status !== 1) throw new Error("deploy reverted");
  console.log("done — check", destination, "for swept assets.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
