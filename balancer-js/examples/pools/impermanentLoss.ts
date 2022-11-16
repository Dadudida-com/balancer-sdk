/**
 * calculate impermanent loss for a pool from a given timestamp.
 *
 * Run command: npm run examples:run -- ./examples/pools/impermanentLoss.ts
 *
 */

import dotenv from "dotenv";
import {BalancerError, BalancerErrorCode, BalancerSDK} from "../../src";

dotenv.config();

const sdk = new BalancerSDK({
  network: 1,
  rpcUrl: `${process.env.ALCHEMY_URL}`,
});

const { pools } = sdk;

const { poolJoinExits } = sdk.data;

const main = async (): Promise<void> => {
  await impermanentLoss('0x0647721e414a7ab11817427c6f49d0d15d6aae53', '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014');
  await impermanentLoss('0x0a53d9586dd052a06fca7649a02b973cc164c1b4', '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014');
  await impermanentLoss('0x000000000088e0120f9e6652cc058aec07564f69', '0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014');
  await impermanentLoss('0x07dd13b2705050b2f5c60da9f7f0f37b7395945a', '0xc45d42f801105e861e86658648e3678ad7aa70f900010000000000000000011e');
  await impermanentLoss('0x00bcfc8f7471b2e4d21af417dea393c1578c67c1', '0x1e19cf2d73a72ef1332c882f20534b6519be0276000200000000000000000112');
  // await impermanentLoss('0x0035fc5208ef989c28d47e552e92b0c507d2b318');
}

const impermanentLoss = async (userAddress: string, poolId: string): Promise<void> => {
  const joinExists = await poolJoinExits.findByUser(userAddress);
  const joins = joinExists.filter((it) => it.type === "Join" && it.poolId === poolId);
  if (!joins.length) {
    console.log(`${userAddress}: No Pool found`);
    return;
  }
  const timestamp = joins[0].timestamp;

  const pool = await sdk.pools.find(poolId);
  if (!pool) {
    throw new BalancerError(BalancerErrorCode.POOL_DOESNT_EXIST);
  }
  try {
    const IL = await pools.impermanentLoss(timestamp, pool);
    console.log(`${userAddress} ${poolId} ${new Date(timestamp * 1000).toLocaleString()} => ${IL}%`);
  } catch (e: any) {
    console.error(`${userAddress} ${poolId} ${new Date(timestamp * 1000).toLocaleString()} => Error: ${e.message}`);
  }
}

main().then(() => console.log('done'));