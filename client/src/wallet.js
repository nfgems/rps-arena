/**
 * Wallet integration for RPS Arena
 * Web3 provider connection and transaction handling
 */

const Wallet = (function () {
  // State
  let provider = null;
  let signer = null;
  let address = null;
  let connected = false;

  // Constants
  const BASE_CHAIN_ID = '0x2105'; // 8453 in hex
  const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const USDC_DECIMALS = 6;

  // USDC ABI (minimal for transfer)
  const USDC_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
  ];

  /**
   * Convert amount to USDC units using string parsing (avoids floating-point precision loss)
   */
  function toUSDCUnits(amount) {
    const [whole, decimal = ''] = amount.toString().split('.');
    const paddedDecimal = decimal.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
    return BigInt(whole + paddedDecimal);
  }

  /**
   * Check if Web3 wallet is available
   */
  function isAvailable() {
    return typeof window.ethereum !== 'undefined';
  }

  /**
   * Connect to wallet
   */
  async function connect() {
    if (!isAvailable()) {
      throw new Error('No Web3 wallet detected. Please install MetaMask or similar.');
    }

    try {
      // Request account access
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts',
      });

      if (accounts.length === 0) {
        throw new Error('No accounts found');
      }

      address = accounts[0];

      // Check and switch to Base network
      await switchToBase();

      // Create ethers provider and signer
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();

      connected = true;

      // Listen for account changes
      window.ethereum.on('accountsChanged', handleAccountsChanged);
      window.ethereum.on('chainChanged', handleChainChanged);

      return address;
    } catch (error) {
      console.error('Wallet connection failed:', error);
      throw error;
    }
  }

  /**
   * Disconnect wallet
   */
  function disconnect() {
    provider = null;
    signer = null;
    address = null;
    connected = false;

    if (window.ethereum) {
      window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
      window.ethereum.removeListener('chainChanged', handleChainChanged);
    }
  }

  /**
   * Switch to Base network
   */
  async function switchToBase() {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_CHAIN_ID }],
      });
    } catch (switchError) {
      // Chain not added, try to add it
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: BASE_CHAIN_ID,
            chainName: 'Base',
            nativeCurrency: {
              name: 'Ether',
              symbol: 'ETH',
              decimals: 18,
            },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org'],
          }],
        });
      } else {
        throw switchError;
      }
    }
  }

  /**
   * Sign a message for authentication
   */
  async function signMessage(message) {
    if (!signer) {
      throw new Error('Wallet not connected');
    }

    return await signer.signMessage(message);
  }

  /**
   * Send USDC payment
   */
  async function sendUSDC(recipientAddress, amount) {
    if (!signer) {
      throw new Error('Wallet not connected');
    }

    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);

    // Amount in smallest units (6 decimals) - use string parsing to avoid precision loss
    const amountInUnits = toUSDCUnits(amount);

    // Check balance first
    const balance = await usdc.balanceOf(address);
    if (BigInt(balance) < amountInUnits) {
      throw new Error('Insufficient USDC balance');
    }

    // Send transaction
    const tx = await usdc.transfer(recipientAddress, amountInUnits);
    const receipt = await tx.wait();

    return receipt.hash;
  }

  /**
   * Get USDC balance
   */
  async function getUSDCBalance() {
    if (!provider || !address) {
      return 0;
    }

    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    const balance = await usdc.balanceOf(address);

    return Number(balance) / 10 ** USDC_DECIMALS;
  }

  /**
   * Handle account changes
   */
  function handleAccountsChanged(accounts) {
    if (accounts.length === 0) {
      // User disconnected
      disconnect();
      window.dispatchEvent(new CustomEvent('wallet:disconnected'));
    } else if (accounts[0] !== address) {
      // Account changed
      address = accounts[0];
      window.dispatchEvent(new CustomEvent('wallet:accountChanged', { detail: address }));
    }
  }

  /**
   * Handle chain changes
   */
  function handleChainChanged(chainId) {
    if (chainId !== BASE_CHAIN_ID) {
      window.dispatchEvent(new CustomEvent('wallet:wrongNetwork'));
    }
  }

  /**
   * Get connected address
   */
  function getAddress() {
    return address;
  }

  /**
   * Check if connected
   */
  function isConnected() {
    return connected;
  }

  /**
   * Truncate address for display
   */
  function truncateAddress(addr) {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // Public API
  return {
    isAvailable,
    connect,
    disconnect,
    signMessage,
    sendUSDC,
    getUSDCBalance,
    getAddress,
    isConnected,
    truncateAddress,
  };
})();
