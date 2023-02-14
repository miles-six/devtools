import { configExist, getConfig } from "./utils/fileConfigHelper";
import { executeTransaction, executeGnosisTransactions, getContractAt, getWalletContractAt, Transaction, NetworkTransactions, getContract, getWalletContract } from "./utils/crossChainHelper";
import { promptToProceed, writeToCsv, logError, logWarning, printTransactions } from "./utils/helpers";
import { utils, constants } from "ethers";
const { LZ_ADDRESS, CHAIN_ID } = require("@layerzerolabs/lz-sdk");

// Application config types from UltraLightNodeV2 contract
const CONFIG_TYPE_INBOUND_PROOF_LIBRARY_VERSION = 1;
const CONFIG_TYPE_INBOUND_BLOCK_CONFIRMATIONS = 2;
const CONFIG_TYPE_RELAYER = 3;
const CONFIG_TYPE_OUTBOUND_PROOF_TYPE = 4;
const CONFIG_TYPE_OUTBOUND_BLOCK_CONFIRMATIONS = 5;
const CONFIG_TYPE_ORACLE = 6;

const endpointAbi = [
	"function uaConfigLookup(address) view returns (tuple(uint16, uint16, address, address))", 
	"function getConfig(uint16,uint16, address _userApplication, uint _configType) external view returns (bytes memory)"
]

const uaAbi = [
	"function setConfig(uint16 _version, uint16 _chainId, uint _configType, bytes calldata _config)", 
	"function setSendVersion(uint16 _version)", 
	"function setReceiveVersion(uint16 _version)"
]

module.exports = async (taskArgs: any, hre: any) => {
	const uaConfigPath = taskArgs.uaConfig;
	const contractName = taskArgs.contractName;
	const uaAddressesConfigPath = taskArgs.uaAddressesConfig;
	const gnosisConfigPath = taskArgs.gnosisConfig;
	const sendToGnosis = gnosisConfigPath && configExist(gnosisConfigPath);

	if (!uaConfigPath || !configExist(uaConfigPath)) {
		logError(`User application config file is not found`);
		return;
	}

	if (!contractName && (!uaAddressesConfigPath || !configExist(uaAddressesConfigPath))) {
		logError(`Contract name isn't provided and a config file with contract addresses is not found`);
		return;
	}

	const uaAddresses = getConfig(uaAddressesConfigPath);
	const config = getConfig(uaConfigPath);
	const networks = taskArgs.networks;

	const transactionByNetwork: any[] = (
		await Promise.all(
			networks.map(async (network: string) => {
				const transactions: Transaction[] = [];

				const endpoint = await getContractAt(hre, network, "Endpoint", endpointAbi, LZ_ADDRESS[network]);
				let ua: any;
				if (contractName) {
					ua = await getContract(hre, network, contractName);
				}
				else {
					const uaInfo = uaAddresses[network];
					if (!uaInfo || (!uaInfo.address && !uaInfo.contractName)) {
						logWarning(`Contract information isn't found for ${network}`)
						return;
					}
					ua = await getContractAt(hre, network, uaInfo.contractName, uaAbi, uaInfo.address);
				}
				
				const chainId = CHAIN_ID[network];
				const networkConfig = config[network];

				if (networkConfig === undefined) return;
				const uaConfig = await endpoint.uaConfigLookup(ua.address);

				if (networkConfig.sendVersion) {
					transactions.push(...(await setSendVersion(chainId, ua, uaConfig[0], networkConfig.sendVersion)));
				}

				if (networkConfig.receiveVersion) {
					transactions.push(...(await setReceiveVersion(chainId, ua, uaConfig[1], networkConfig.receiveVersion)));
				}

				const remoteConfigs = networkConfig.remoteConfigs;
				const configVersion = networkConfig.sendVersion;

				if (!configVersion) {
					logWarning(`Send Library version isn't specified for ${network}`);
					return;
				}

				await Promise.all(
					remoteConfigs.map(async (remoteConfig: any) => {
						if (remoteConfig.remoteChain === network) return;
						const remoteChainId = CHAIN_ID[remoteConfig.remoteChain];

						if (remoteConfig.inboundProofLibraryVersion) {
							transactions.push(...(await setConfig(configVersion, chainId, remoteChainId, endpoint, ua, CONFIG_TYPE_INBOUND_PROOF_LIBRARY_VERSION, "uint16", remoteConfig.inboundProofLibraryVersion)));
						}

						if (remoteConfig.inboundBlockConfirmations) {
							transactions.push(...(await setConfig(configVersion, chainId, remoteChainId, endpoint, ua, CONFIG_TYPE_INBOUND_BLOCK_CONFIRMATIONS, "uint64", remoteConfig.inboundBlockConfirmations)));
						}

						if (remoteConfig.relayer) {
							transactions.push(...(await setConfig(configVersion, chainId, remoteChainId, endpoint, ua, CONFIG_TYPE_RELAYER, "address", remoteConfig.relayer)));
						}

						if (remoteConfig.outboundProofType) {
							transactions.push(...(await setConfig(configVersion, chainId, remoteChainId, endpoint, ua, CONFIG_TYPE_OUTBOUND_PROOF_TYPE, "uint16", remoteConfig.outboundProofType)));
						}

						if (remoteConfig.outboundBlockConfirmations) {
							transactions.push(...(await setConfig(configVersion, chainId, remoteChainId, endpoint, ua, CONFIG_TYPE_OUTBOUND_BLOCK_CONFIRMATIONS, "uint64", remoteConfig.outboundBlockConfirmations)));
						}

						if (remoteConfig.oracle) {
							transactions.push(...(await setConfig(configVersion, chainId, remoteChainId, endpoint, ua, CONFIG_TYPE_ORACLE, "address", remoteConfig.oracle)));
						}
					})
				);
				return {
					network: network,
					transactions,
				};
			})
		)
	).filter((x) => x);

	const columns = ["needChange", "chainId", "remoteChainId", "contractAddress", "methodName", "args", "diff"];
	const changeNeeded = printTransactions(columns, transactionByNetwork);
	writeToCsv("./setConfigTxs.csv", columns, transactionByNetwork);

	if (!changeNeeded) return; 

	await promptToProceed(sendToGnosis ? "Would you like to proceed with above instructions in Gnosis?" : "Would you like to proceed with above instruction?");
	
	const errs: any[] = [];
	const print: any = {};
	let previousPrintLine = 0;
	const printResult = () => {
		if (previousPrintLine) {
			process.stdout.moveCursor(0, -previousPrintLine);
		}
		if (Object.keys(print)) {
			previousPrintLine = Object.keys(print).length + 4;
			console.table(Object.keys(print).map((network) => ({ network, ...print[network] })));
		}
	};

	if (sendToGnosis) {
		const gnosisConfig = getConfig(gnosisConfigPath);
		 await Promise.all(
			transactionByNetwork.map(async ({ network, transactions }) => {
				const transactionToCommit = transactions.filter((transaction: Transaction) => transaction.needChange);

				print[network] = print[network] || { requests: "1/1" };
				print[network].current = `executeGnosisTransactions: ${transactionToCommit}`;
				try {
					await executeGnosisTransactions(hre, network, gnosisConfig, transactionToCommit);
					print[network].requests = "1/1";
					printResult();
				} catch (err: any) {
					console.log(`Failing calling executeGnosisTransactions for network ${network} with err ${err}`);
					errs.push({	network, err });
					print[network].current = err.message;
					print[network].err = true;
					printResult();
				}
			})
		);
	} 
	else {
		await Promise.all(
			transactionByNetwork.map(async ({ network, transactions }) => {
				const transactionToCommit = transactions.filter((transaction: Transaction) => transaction.needChange);
				const ua = contractName 
					? await getWalletContract(hre, network, contractName) 
					: await getWalletContractAt(hre, network, uaAddresses[network].contractName, uaAbi, uaAddresses[network].address);

				let successTx = 0;
				print[network] = print[network] || { requests: `${successTx}/${transactionToCommit.length}` };
				for (let transaction of transactionToCommit) {
					print[network].current = `${transaction.methodName}(${transaction.args})`;
					printResult();
					try {
						const tx = await executeTransaction(hre, network, transaction, ua);
						print[network].past = `${transaction.methodName}(${transaction.args}) (${tx.transactionHash})`;
						successTx++;
						print[network].requests = `${successTx}/${transactionToCommit.length}`;
						printResult();
					} catch (err: any) {
						console.log(`Failing calling ${transaction.contractName}.${transaction.methodName} for network ${network} with err ${err}`);
						console.log(err);
						errs.push({ network, err });
						print[network].current = err;
						print[network].err = true;
						printResult();
						break;
					}
				}
			})
		);
	}

	console.log(errs.length ? errs : "Set UA config on all networks successfully");
}

const setSendVersion = async (chainId: string, ua: any, currentSendVersion: any, newSendVersion: any): Promise<Transaction[]> => {
	const needChange = currentSendVersion !== newSendVersion;
	const contractAddress = ua.address;
	const methodName = "setSendVersion";
	const args = [newSendVersion];
	const calldata = ua.interface.encodeFunctionData(methodName, args);
	const diff = needChange ? { oldValue: currentSendVersion, newValue: newSendVersion } : undefined;

	return [{ needChange, chainId, contractAddress, methodName, args, calldata, diff }];
};

const setReceiveVersion = async (chainId: string, ua: any, currentReceiveVersion: any, newReceiveVersion: any): Promise<Transaction[]> => {
	const needChange = currentReceiveVersion !== newReceiveVersion;
	const contractAddress = ua.address;
	const methodName = "setReceiveVersion";
	const args = [newReceiveVersion];
	const calldata = ua.interface.encodeFunctionData(methodName, args);
	const diff = needChange ? { oldValue: currentReceiveVersion, newValue: newReceiveVersion } : undefined;

	return [{ needChange, chainId, contractAddress, methodName, args, calldata, diff }];
};

const setConfig = async (configVersion: any, chainId: string, remoteChainId: string, endpoint: any, ua: any, configType: number, configValueType: string, newValue: any): Promise<Transaction[]> => {
	const currentConfig = await endpoint.getConfig(configVersion, remoteChainId, ua.address, configType);
	const [oldValue] = utils.defaultAbiCoder.decode([configValueType], currentConfig) as any;
	const newConfig = utils.defaultAbiCoder.encode([configValueType], [newValue]);
	const contractAddress = ua.address;
	const methodName = "setConfig";
	const args = [configVersion, remoteChainId, configType, newConfig];
	const needChange = oldValue !== newValue;
	const calldata = ua.interface.encodeFunctionData(methodName, args);
	const diff = needChange ? { oldValue, newValue } : undefined;

	return [{ needChange, chainId, remoteChainId, contractAddress, methodName, args, calldata, diff }];
};
