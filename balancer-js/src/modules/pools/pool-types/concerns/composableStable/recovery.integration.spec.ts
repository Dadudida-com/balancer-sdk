// yarn test:only ./src/modules/pools/pool-types/concerns/composableStable/recovery.integration.spec.ts
import dotenv from 'dotenv';
import { ethers } from 'hardhat';
import { parseFixed } from '@ethersproject/bignumber';
import {
  BalancerSDK,
  getPoolAddress,
  Network,
  GraphQLArgs,
  GraphQLQuery,
} from '@/.';
import { forkSetup } from '@/test/lib/utils';
import { assertRecoveryExit } from '@/test/lib/exitHelper';

dotenv.config();

const network = Network.POLYGON;
const { ALCHEMY_URL_POLYGON: jsonRpcUrl } = process.env;
const rpcUrl = 'http://127.0.0.1:8137';
const provider = new ethers.providers.JsonRpcProvider(rpcUrl, network);
const signer = provider.getSigner();
// This pool has active rates which is needed for tests
const testPoolId =
  '0x02d2e2d7a89d6c5cb3681cfcb6f7dac02a55eda400000000000000000000088f';
const blockNumber = 46417427;
let balancer: BalancerSDK;

describe('ComposableStable - recovery', () => {
  // We have to reset the fork between each test as pool value changes after tx is submitted
  beforeEach(async () => {
    // Setup forked network, set initial token balances and allowances
    await forkSetup(
      signer,
      [getPoolAddress(testPoolId)],
      [0],
      [parseFixed('10000', 18).toString()],
      jsonRpcUrl as string,
      blockNumber
    );
    const subgraphArgs: GraphQLArgs = {
      where: {
        id: {
          in: [testPoolId],
        },
      },
      block: { number: blockNumber },
    };

    const subgraphQuery: GraphQLQuery = { args: subgraphArgs, attrs: {} };
    balancer = new BalancerSDK({
      network,
      rpcUrl,
      subgraphQuery,
    });
  });

  context('buildRecoveryExit', async () => {
    context('PoolWithMethods', async () => {
      it('should recovery exit', async () => {
        const bptAmount = parseFixed('1.34', 18).toString();
        const slippage = '10'; // 10 bps = 0.1%
        const pool = await balancer.pools.find(testPoolId);
        if (!pool) throw Error('Pool not found');
        const signerAddr = await signer.getAddress();
        const { to, data, minAmountsOut, expectedAmountsOut, priceImpact } =
          pool.buildRecoveryExit(signerAddr, bptAmount, slippage);
        await assertRecoveryExit(
          signerAddr,
          slippage,
          to,
          data,
          minAmountsOut,
          expectedAmountsOut,
          priceImpact,
          pool,
          signer,
          bptAmount
        );
      });
    });
    context('Pool & refresh', async () => {
      it('should recovery exit', async () => {
        const bptAmount = parseFixed('1.34', 18).toString();
        const slippage = '10'; // 10 bps = 0.1%
        let pool = await balancer.data.pools.find(testPoolId);
        if (!pool) throw Error('Pool not found');
        const signerAddr = await signer.getAddress();
        pool = await balancer.data.poolsOnChain.refresh(pool);
        const { to, data, expectedAmountsOut, minAmountsOut, priceImpact } =
          balancer.pools.buildRecoveryExit({
            pool,
            bptAmount,
            userAddress: signerAddr,
            slippage,
          });
        await assertRecoveryExit(
          signerAddr,
          slippage,
          to,
          data,
          minAmountsOut,
          expectedAmountsOut,
          priceImpact,
          pool,
          signer,
          bptAmount
        );
      });
    });
  });
});
