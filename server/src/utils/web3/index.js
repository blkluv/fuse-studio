const Web3 = require('web3')
const ethUtils = require('ethereumjs-util')
const config = require('config')
const { fromMasterSeed } = require('ethereumjs-wallet/hdkey')
const { inspect } = require('util')
const mongoose = require('mongoose')
const Account = mongoose.model('Account')
const { fetchGasPrice } = require('@utils/network')
const wallet = fromMasterSeed(config.get('secrets.accounts.seed'))

const createWeb3 = (providerUrl) => {
  const web3 = new Web3(providerUrl)
  const account = web3.eth.accounts.wallet.add(ethUtils.addHexPrefix(config.get('secrets.fuse.bridge.privateKey')))
  return { from: account.address, web3 }
}

const createContract = ({ web3, bridgeType }, abi, address) =>
  new web3.eth.Contract(abi, address, config.get(`network.${bridgeType}.contract.options`))

const createMethod = (contract, methodName, ...args) => {
  console.log(`creating method ${methodName} with arguments: ${inspect(args)}`)

  let method
  if (methodName === 'deploy') {
    method = contract[methodName](...args)
  } else {
    method = contract.methods[methodName](...args)
  }
  method.methodName = methodName
  method.contract = contract
  return method
}

const getMethodName = (method) => method.methodName || 'unknown'

const getGasPrice = async (bridgeType, web3) => {
  if (bridgeType === 'home') {
    return config.get('network.home.gasPrice')
  }
  const gasPrice = await fetchGasPrice('fast')
  return web3.utils.toWei(gasPrice.toString(), 'gwei')
}

const retries = 3

const TRANSACTION_HASH_IMPORTED = 'Node error: {"code":-32010,"message":"Transaction with the same hash was already imported."}'
const TRANSACTION_HASH_TOO_LOW = 'Node error: {"code":-32010,"message":"Transaction nonce is too low. Try incrementing the nonce."}'
const TRANSACTION_TIMEOUT = 'Error: Timeout exceeded during the transaction confirmation process. Be aware the transaction could still get confirmed!'

const send = async ({ web3, bridgeType, address }, method, options) => {
  const doSend = async (retry) => {
    let transactionHash
    const methodName = getMethodName(method)
    const nonce = account.nonces[bridgeType]
    console.log(`[${bridgeType}][retry: ${retry}] sending method ${methodName} from ${from} with nonce ${nonce}. gas price: ${gasPrice}, gas limit: ${gas}, options: ${inspect(options)}`)
    const methodParams = { gasPrice, ...options, gas, nonce: nonce, chainId: bridgeType === 'home' ? config.get('network.home.chainId') : undefined }
    const promise = method.send({ ...methodParams })
    promise.on('transactionHash', (hash) => {
      transactionHash = hash
    })

    try {
      const receipt = await promise
      console.log(`[${bridgeType}] method ${methodName} succeeded in tx ${receipt.transactionHash}`)
      return { receipt }
    } catch (error) {
      console.error(error)

      const updateNonce = async () => {
        const nonce = await web3.eth.getTransactionCount(from)
        account.nonces[bridgeType] = nonce
      }

      const errorHandlers = {
        [TRANSACTION_HASH_IMPORTED]: async () => {
          if (transactionHash) {
            const receipt = await web3.eth.getTransactionReceipt(transactionHash)
            return { receipt }
          }
        },
        [TRANSACTION_HASH_TOO_LOW]: updateNonce,
        [TRANSACTION_TIMEOUT]: updateNonce
      }
      const errorMessage = error.message || error.error
      if (errorHandlers.hasOwnProperty(errorMessage)) {
        return errorHandlers[errorMessage]()
      } else {
        return updateNonce()
      }
    }
  }

  const from = address
  const gas = await method.estimateGas({ from })
  const gasPrice = await getGasPrice(bridgeType, web3)
  const account = await Account.findOne({ address })
  for (let i = 0; i < retries; i++) {
    const response = await doSend(i) || {}
    const { receipt } = response
    if (receipt) {
      account.nonces[bridgeType]++
      await Account.updateOne({ address }, { [`nonces.${bridgeType}`]: account.nonces[bridgeType] })
      return receipt
    }
  }
}

const getPrivateKey = (account) => {
  const derivedWallet = wallet.deriveChild(account.childIndex).getWallet()
  const derivedAddress = derivedWallet.getChecksumAddressString()
  if (account.address !== derivedAddress) {
    throw new Error(`Account address does not match with the private key. account address: ${account.address}, derived: ${derivedAddress}`)
  }
  return ethUtils.addHexPrefix(ethUtils.bufferToHex(derivedWallet.getPrivateKey()))
}

const createNetwork = (bridgeType, account) => {
  const web3 = new Web3(config.get(`network.${bridgeType}.provider`))
  web3.eth.accounts.wallet.add(getPrivateKey(account))

  return {
    from: account.address,
    web3,
    createContract: createContract.bind(null, { web3, bridgeType, address: account.address }),
    createMethod,
    send: send.bind(null, { web3, bridgeType, address: account.address })
  }
}

const toBufferStripPrefix = (str) => Buffer.from(ethUtils.stripHexPrefix(str), 'hex')

const generateSignature = async (method, methodArguments, privateKey) => {
  const msg = await method(...methodArguments).call()
  const vrs = ethUtils.ecsign(toBufferStripPrefix(msg), toBufferStripPrefix(privateKey))
  return ethUtils.toRpcSig(vrs.v, vrs.r, vrs.s)
}

module.exports = {
  createWeb3,
  generateSignature,
  createContract,
  createMethod,
  send,
  createNetwork
}