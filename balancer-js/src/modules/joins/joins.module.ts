import { Interface } from '@ethersproject/abi';
import { BigNumber } from '@ethersproject/bignumber';
import { AddressZero, MaxInt256 } from '@ethersproject/constants';

import { BalancerError, BalancerErrorCode } from '@/balancerErrors';
import { Relayer } from '@/modules/relayer/relayer.module';
import { BatchSwapStep, FundManagement, SwapType } from '@/modules/swaps/types';
import { StablePoolEncoder } from '@/pool-stable';
import { JoinPoolRequest, PoolType } from '@/types';
import { PoolRepository } from '../data';
import { PoolGraph, Node } from './graph';

import balancerRelayerAbi from '@/lib/abi/BalancerRelayer.json';
import { networkAddresses } from '@/lib/constants/config';
import { AssetHelpers } from '@/lib/utils';
const balancerRelayerInterface = new Interface(balancerRelayerAbi);

export class Join {
  totalProportions: Record<string, BigNumber> = {};
  private relayer: string;
  private wrappedNativeAsset;
  constructor(private pools: PoolRepository, chainId: number) {
    const { tokens, contracts } = networkAddresses(chainId);
    this.relayer = contracts.relayer as string;
    this.wrappedNativeAsset = tokens.wrappedNativeAsset;
  }

  async joinPool(
    poolId: string,
    expectedBPTOut: string,
    tokens: string[],
    amounts: string[],
    userAddress: string,
    wrapMainTokens: boolean,
    authorisation?: string
  ): Promise<{
    to: string;
    data: string;
    decode: (output: string) => string;
  }> {
    const rootPool = await this.pools.find(poolId);
    if (!rootPool) throw new BalancerError(BalancerErrorCode.POOL_DOESNT_EXIST);
    const poolsGraph = new PoolGraph(this.pools);

    const rootNode = await poolsGraph.buildGraphFromRootPool(
      poolId,
      wrapMainTokens
    );
    const orderedNodes = poolsGraph.orderByBfs(rootNode);
    const calls = this.createActionCalls(
      orderedNodes,
      poolId,
      expectedBPTOut,
      tokens.map((token) => token.toLowerCase()),
      amounts,
      userAddress,
      authorisation
    );

    const callData = balancerRelayerInterface.encodeFunctionData('multicall', [
      calls,
    ]);

    return {
      to: this.relayer,
      data: callData,
      decode: (output) => {
        return output; // TODO: add decode function
      },
    };
  }

  createActionCalls(
    orderedNodes: Node[],
    rootId: string,
    expectedBPTOut: string,
    tokens: string[],
    amounts: string[],
    userAddress: string,
    authorisation?: string
  ): string[] {
    const calls: string[] = [];
    if (authorisation) {
      calls.push(this.createSetRelayerApproval(authorisation));
    }
    this.updateTotalProportions(orderedNodes);
    // Create actions for each Node and return in multicall array
    orderedNodes.forEach((node) => {
      // if all child nodes have 0 output amount, then forward it to outputRef and skip adding current call
      if (
        node.action !== 'input' &&
        node.children.filter((c) => c.outputReference !== '0').length === 0
      ) {
        node.outputReference = '0';
        return;
      }
      const expectedOut = node.id === rootId ? expectedBPTOut : '0';
      const sender = node.children.some(
        (c) => c.action === 'input' || c.action === 'wrapAaveDynamicToken'
      )
        ? userAddress
        : this.relayer;
      const recipient = node.id === rootId ? userAddress : this.relayer; // last chained action
      switch (node.action) {
        // TODO - Add other Relayer supported Unwraps
        case 'wrapAaveDynamicToken':
          calls.push(this.createAaveWrap(node, sender, userAddress)); // relayer is not allowed to spend its own wrapped tokens, so recipient must be the user
          break;
        case 'batchSwap':
          calls.push(
            this.createBatchSwap(node, expectedOut, sender, recipient)
          );
          break;
        case 'joinPool':
          calls.push(this.createJoinPool(node, expectedOut, sender, recipient));
          break;
        case 'input':
          this.createMainToken(node, tokens, amounts);
          break;
        default: {
          const inputs = node.children.map((t) => {
            return t.outputReference;
          });
          console.log(
            'Unsupported action',
            node.type,
            node.address,
            node.action,
            `Inputs: ${inputs.toString()}`,
            `OutputRef: ${node.outputReference}`,
            node.proportionOfParent.toString()
          );
        }
      }
    });
    return calls;
  }

  /*
  This creates a map of node address and total proportion.
  Useful for the case where there may be multiple inputs using same token, e.g. DAI input to 2 pools.
  */
  updateTotalProportions(nodes: Node[]): void {
    this.totalProportions = {};
    nodes.forEach((node) => {
      if (!this.totalProportions[node.address])
        this.totalProportions[node.address] = node.proportionOfParent;
      else {
        this.totalProportions[node.address] = this.totalProportions[
          node.address
        ].add(node.proportionOfParent);
      }
    });
  }

  /**
   * Uses relayer to approve itself to act in behalf of the user
   *
   * @param authorisation Encoded authorisation call.
   * @returns relayer approval call
   */
  createSetRelayerApproval(authorisation: string): string {
    return Relayer.encodeSetRelayerApproval(this.relayer, true, authorisation);
  }

  /*
  These nodes don't have an action but create the correct proportional inputs for each token.
  These input amounts are then copied to the outputRef which the parent node will use.
  */
  createMainToken(node: Node, tokens: string[], amounts: string[]): void {
    // Update amounts to use actual value based off input and proportions
    const tokenIndex = tokens.indexOf(node.address);
    if (tokenIndex === -1) return;

    const totalProportion = this.totalProportions[node.address];
    const inputProportion = node.proportionOfParent
      .mul((1e18).toString())
      .div(totalProportion);
    const inputAmount = inputProportion
      .mul(amounts[tokenIndex])
      .div((1e18).toString());
    node.outputReference = inputAmount.toString();
    console.log(
      `${node.type} ${node.address} prop: ${node.proportionOfParent.toString()}
      ${node.action} (
        Inputs: ${inputAmount.toString()}
        OutputRef: ${node.outputReference}
      )`
    );
  }

  createAaveWrap(node: Node, sender: string, recipient: string): string {
    // TODO: check if it's possible to have more than one child at this type of node
    // This might be the case for joining with non-leaf tokens
    // Can aaveWraps be applied to tokens other than stables? Is it possible for stables to be non-leaf nodes? If not, then there will always be 1 child for this type of node.
    const childNode = node.children[0];

    const staticToken = node.address;
    const amount = childNode.outputReference;
    const call = Relayer.encodeWrapAaveDynamicToken({
      staticToken,
      sender,
      recipient,
      amount,
      fromUnderlying: true,
      outputReference: Relayer.toChainedReference(node.outputReference),
    });

    console.log(
      `${node.type} ${node.address} prop: ${node.proportionOfParent.toString()}
      ${node.action} (
        staticToken: ${staticToken},
        input: ${amount},
        outputRef: ${node.outputReference.toString()}
      )`
    );

    return call;
  }

  createBatchSwap(
    node: Node,
    expectedOut: string,
    sender: string,
    recipient: string
  ): string {
    const inputAmt = node.children[0].outputReference;
    const inputToken = node.children[0].address;
    const outputToken = node.address;
    const poolId = node.id;
    console.log(
      `${node.type} ${node.address} prop: ${node.proportionOfParent.toString()}
      ${node.action}(
        inputAmt: ${inputAmt},
        inputToken: ${inputToken},
        pool: ${poolId},
        outputToken: ${outputToken},
        outputRef: ${node.outputReference}
      )`
    );

    const inputTokens: string[] = [];
    const inputAmts: string[] = [];

    node.children.forEach((child) => {
      if (child.outputReference !== '0') {
        inputTokens.push(child.address);
        inputAmts.push(
          Relayer.toChainedReference(child.outputReference).toString()
        );
      }
    });

    const assets = [node.address, ...inputTokens];

    // For tokens going in to the Vault, the limit shall be a positive number. For tokens going out of the Vault, the limit shall be a negative number.
    const limits: string[] = [
      BigNumber.from(expectedOut).mul(-1).toString(),
      ...inputAmts.map(() => MaxInt256.toString()), // TODO: check if it's worth limiting inputs as well - if yes, how to get the amount from children nodes?
    ];

    const swaps: BatchSwapStep[] = inputTokens.map((token, i) => {
      return {
        poolId: node.id,
        assetInIndex: assets.indexOf(token),
        assetOutIndex: assets.indexOf(node.address),
        amount: inputAmts[i],
        userData: '0x',
      };
    });

    const funds: FundManagement = {
      sender,
      recipient,
      fromInternalBalance: sender === this.relayer,
      toInternalBalance: recipient === this.relayer,
    };

    const outputReferences = [
      {
        index: assets.indexOf(node.address),
        key: Relayer.toChainedReference(node.outputReference),
      },
    ];

    const call = Relayer.encodeBatchSwap({
      swapType: SwapType.SwapExactIn,
      swaps,
      assets,
      funds,
      limits,
      deadline: BigNumber.from(Math.ceil(Date.now() / 1000) + 3600), // 1 hour from now
      value: '0',
      outputReferences,
    });

    return call;
  }

  createJoinPool(
    node: Node,
    minAmountOut: string,
    sender: string,
    recipient: string
  ): string {
    const poolId = node.id;
    const inputTokens: string[] = [];
    const inputAmts: string[] = [];

    // inputTokens needs to include each asset even if it has 0 amount
    node.children.forEach((child) => {
      inputTokens.push(child.address);
      inputAmts.push(
        child.outputReference !== '0'
          ? Relayer.toChainedReference(child.outputReference).toString()
          : '0'
      );
    });

    if (node.type === PoolType.ComposableStable) {
      // assets need to include the phantomPoolToken
      inputTokens.push(node.address);
      // need to add a placeholder so sorting works
      inputAmts.push('0');
    }

    console.log(
      `${node.type} ${node.address} prop: ${node.proportionOfParent.toString()}
      ${node.action}(
        poolId: ${poolId},
        inputTokens: ${inputTokens.toString()},
        maxAmtsIn: ${node.children.map((c) => c.outputReference).toString()},
        minOut: ${minAmountOut}
        outputRef: ${node.outputReference}
      )`
    );

    // sort inputs
    const assetHelpers = new AssetHelpers(this.wrappedNativeAsset);
    const [sortedTokens, sortedAmounts] = assetHelpers.sortTokens(
      inputTokens,
      inputAmts
    ) as [string[], string[]];

    // userData amounts should not include the BPT of the pool being joined
    let userDataAmounts = [];
    const bptIndex = sortedTokens.indexOf(node.address);
    if (bptIndex === -1) {
      userDataAmounts = sortedAmounts;
    } else {
      userDataAmounts = [
        ...sortedAmounts.slice(0, bptIndex),
        ...sortedAmounts.slice(bptIndex + 1),
      ];
    }

    const userData = StablePoolEncoder.joinExactTokensInForBPTOut(
      userDataAmounts,
      minAmountOut
    );

    // TODO: add test to join weth/wsteth pool using ETH
    const ethIndex = sortedTokens.indexOf(AddressZero);
    const value = ethIndex === -1 ? '0' : sortedAmounts[ethIndex];

    const call = Relayer.constructJoinCall({
      poolId: node.id,
      poolKind: 0,
      sender,
      recipient,
      value,
      outputReference: '0',
      joinPoolRequest: {} as JoinPoolRequest,
      assets: sortedTokens, // Must include BPT token
      maxAmountsIn: sortedAmounts,
      userData,
      fromInternalBalance: sender === this.relayer,
    });

    return call;
  }
}
