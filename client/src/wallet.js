/**
 * Wallet integration for RPS Arena
 * Multi-wallet support via EIP-6963 (detects all installed browser wallets)
 */

const Wallet = (function () {
  // State
  let provider = null;
  let signer = null;
  let address = null;
  let connected = false;
  let selectedProvider = null;

  // EIP-6963 detected wallets
  const detectedWallets = new Map();

  // Constants
  const BASE_CHAIN_ID = '0x2105'; // 8453 in hex
  const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const USDC_DECIMALS = 6;

  // USDC ABI (minimal for transfer)
  const USDC_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
  ];

  // Connection promise handlers (for async wallet selection)
  let connectionResolve = null;
  let connectionReject = null;

  /**
   * Initialize EIP-6963 wallet detection
   */
  function initEIP6963() {
    // Listen for wallet announcements (EIP-6963)
    window.addEventListener('eip6963:announceProvider', (event) => {
      const { info, provider } = event.detail;
      console.log('Wallet detected:', info.name);
      detectedWallets.set(info.uuid, { info, provider });
    });

    // Request wallets to announce themselves
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // Also check for legacy window.ethereum after a short delay
    setTimeout(() => {
      if (detectedWallets.size === 0 && window.ethereum) {
        // Fallback: add window.ethereum as a generic wallet
        const legacyInfo = {
          uuid: 'legacy-injected',
          name: window.ethereum.isMetaMask ? 'MetaMask' :
                window.ethereum.isRabby ? 'Rabby' :
                window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser Wallet',
          icon: getDefaultWalletIcon(window.ethereum),
        };
        detectedWallets.set(legacyInfo.uuid, { info: legacyInfo, provider: window.ethereum });
        console.log('Legacy wallet detected:', legacyInfo.name);
      }
    }, 100);
  }

  /**
   * Get a default icon for legacy wallets
   */
  function getDefaultWalletIcon(ethereum) {
    if (ethereum.isMetaMask) {
      return 'data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjM1NSIgdmlld0JveD0iMCAwIDM5NyAzNTUiIHdpZHRoPSIzOTciIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgtMSAtMSkiPjxwYXRoIGQ9Im0xMTQuNjIyNjQ0IDMyNy4xOTU0NzIgNTIuMDA0NzE3IDEzLjgxMDE5OHYtMTguMDU5NDlsNC4yNDUyODMtNC4yNDkyOTJoMjkuNzE2OTgydjIxLjI0NjQ1OSAxNC44NzI1MjNoLTMxLjgzOTYyNGwtMzkuMjY4ODY4LTE2Ljk5NzE2OXoiIGZpbGw9IiNjZGJkYjIiLz48cGF0aCBkPSJtMTk5LjUyODMwNSAzMjcuMTk1NDcyIDUwLjk0MzM5NyAxMy44MTAxOTh2LTE4LjA1OTQ5bDQuMjQ1MjgzLTQuMjQ5MjkyaDI5LjcxNjk4MXYyMS4yNDY0NTkgMTQuODcyNTIzaC0zMS44Mzk2MjNsLTM5LjI2ODg2OC0xNi45OTcxNjl6IiBmaWxsPSIjY2RiZGIyIiB0cmFuc2Zvcm09Im1hdHJpeCgtMSAwIDAgMSA0ODMuOTYyMjcgMCkiLz48cGF0aCBkPSJtMTcwLjg3MjY0NCAyODcuODg5NTIzLTQuMjQ1MjgzIDM1LjA1NjY1NyA1LjMwNjYwNC00LjI0OTI5Mmg1NS4xODg2OGw2LjM2NzkyNSA0LjI0OTI5Mi00LjI0NTI4NC0zNS4wNTY2NTctOC40OTA1NjUtNS4zMTE2MTUtNDIuNDUyODMyIDEuMDYyMzIzeiIgZmlsbD0iIzM5MzkzOSIvPjxwYXRoIGQ9Im0xNDIuMjE2OTg0IDUwLjk5MTUwMjIgMjUuNDcxNjk4IDU5LjQ5MDA4NTggMTEuNjc0NTI4IDE3My4xNTg2NDNoNDEuMzkxNTExbDEyLjczNTg0OS0xNzMuMTU4NjQzIDIzLjM0OTA1Ni01OS40OTAwODU4eiIgZmlsbD0iI2Y4OWMzNSIvPjxwYXRoIGQ9Im0zMC43NzgzMDIzIDE4MS42NTcyMjYtMjkuNzE2OTgxNTMgODYuMDQ4MTYxIDc0LjI5MjQ1MzkzLTQuMjQ5MjkzaDQ3Ljc1OTQzNHYtMzcuMTgxMzAzbC0yLjEyMjY0MS03Ni40ODcyNTMtMTAuNjEzMjA4IDguNDk4NTgzeiIgZmlsbD0iI2Y4OWQzNSIvPjxwYXRoIGQ9Im04Ny4wMjgzMDMyIDE5MS4yMTgxMzQgODcuMDI4MzAxOCAyLjEyNDY0Ni05LjU1MTg4NiA0NC42MTc1NjMtNDEuMzkxNTExLTEwLjYyMzIyOXoiIGZpbGw9IiNkODdjMzAiLz48cGF0aCBkPSJtODcuMDI4MzAzMiAxOTIuMjgwNDU3IDM2LjA4NDkwNTggMzMuOTk0MzM0djMzLjk5NDMzNHoiIGZpbGw9IiNlYThkM2EiLz48cGF0aCBkPSJtMTIzLjExMzIwOSAyMjcuMzM3MTE0IDQyLjQ1MjgzMSAxMC42MjMyMjkgMTMuNzk3MTcgNDUuNjc5ODg4LTkuNTUxODg2IDYuMzY4OTI3LTQ2LjY5ODExNS0yNy42MjU0Njd6IiBmaWxsPSIjZjg5ZDM1Ii8+PHBhdGggZD0ibTEyMy4xMTMyMDkgMjYxLjMzMTQ0OC04LjQ5MDU2NSA2NS44NjQwMjQgNTYuMjUtMzkuMzA1OTQ5eiIgZmlsbD0iI2ViOGYzNSIvPjxwYXRoIGQ9Im0xNzQuMDU2NjA2IDE5My4zNDI3OCA1LjMwNjYwNCA5MC4yOTczNTUtMTUuOTE5ODEyLTQ2Ljc0MjIxMXoiIGZpbGw9IiNlYThlM2EiLz48cGF0aCBkPSJtNzQuMjkyNDUzOSAyNjIuMzkzNzcxIDQ4LjgyMDc1NTEtMS4wNjIzMjMtOC40OTA1NjUgNjUuODY0MDI0eiIgZmlsbD0iI2Q4N2MzMCIvPjxwYXRoIGQ9Im0yNC40MTAzNzc3IDM1NS44NzgxOTMgOTAuMjEyMjY2My0yOC42ODc3OSA0MC4zMzAxOS02NS44NjQwMjQtMjcuNTk0MzM5LTUuMzExNjE2LTQ0LjU3NTQ3IDEuMDYyMzIzIDMuMTgzOTYyIDM0Ljk5NDMzNC04OS4xNTExNjcgNC4yNDkyOTJ6IiBmaWxsPSIjZWI4ZjM1Ii8+PC9nPjwvc3ZnPg==';
    }
    // Generic wallet icon
    return 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjMzMzIi8+PHBhdGggZD0iTTEwIDEyaDIwdjJIMTB2LTJ6bTAgNmgyMHYySDEwdi0yem0wIDZoMTR2MkgxMHYtMnoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';
  }

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
    return detectedWallets.size > 0 || typeof window.ethereum !== 'undefined';
  }

  /**
   * Show wallet selection modal
   */
  function showWalletModal() {
    const modal = document.getElementById('wallet-modal');
    const walletList = document.getElementById('wallet-list');
    const noWalletsMsg = document.getElementById('no-wallets-message');

    // Clear existing options
    walletList.innerHTML = '';

    if (detectedWallets.size === 0) {
      noWalletsMsg.classList.remove('hidden');
      walletList.classList.add('hidden');
    } else {
      noWalletsMsg.classList.add('hidden');
      walletList.classList.remove('hidden');

      // Add wallet options
      detectedWallets.forEach((wallet, uuid) => {
        const option = document.createElement('button');
        option.className = 'wallet-option';
        option.innerHTML = `
          <img src="${wallet.info.icon}" alt="${wallet.info.name}" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjMzMzIi8+PHBhdGggZD0iTTEwIDEyaDIwdjJIMTB2LTJ6bTAgNmgyMHYySDEwdi0yem0wIDZoMTR2MkgxMHYtMnoiIGZpbGw9IiNmZmYiLz48L3N2Zz4='" />
          <div class="wallet-option-info">
            <div class="wallet-option-name">${wallet.info.name}</div>
            <div class="wallet-option-detected">Detected</div>
          </div>
        `;
        option.addEventListener('click', () => selectWallet(uuid));
        walletList.appendChild(option);
      });
    }

    // Show modal
    modal.classList.remove('hidden');

    // Set up cancel button
    document.getElementById('cancel-wallet-btn').onclick = () => {
      hideWalletModal();
      if (connectionReject) {
        connectionReject(new Error('User cancelled connection'));
        connectionReject = null;
        connectionResolve = null;
      }
    };
  }

  /**
   * Hide wallet selection modal
   */
  function hideWalletModal() {
    document.getElementById('wallet-modal').classList.add('hidden');
  }

  /**
   * Handle wallet selection from modal
   */
  async function selectWallet(uuid) {
    const wallet = detectedWallets.get(uuid);
    if (!wallet) return;

    hideWalletModal();

    try {
      selectedProvider = wallet.provider;

      // Request account access
      const accounts = await selectedProvider.request({
        method: 'eth_requestAccounts',
      });

      if (accounts.length === 0) {
        throw new Error('No accounts found');
      }

      // Create ethers provider and signer
      provider = new ethers.BrowserProvider(selectedProvider);
      signer = await provider.getSigner();

      // Get checksummed address from signer (EIP-55 format required for SIWE)
      address = await signer.getAddress();

      // Check and switch to Base network
      await switchToBase();

      connected = true;

      // Listen for account changes
      selectedProvider.removeListener('accountsChanged', handleAccountsChanged);
      selectedProvider.removeListener('chainChanged', handleChainChanged);
      selectedProvider.on('accountsChanged', handleAccountsChanged);
      selectedProvider.on('chainChanged', handleChainChanged);

      // Resolve the connection promise
      if (connectionResolve) {
        connectionResolve(address);
        connectionResolve = null;
        connectionReject = null;
      }

    } catch (error) {
      console.error('Wallet connection failed:', error);
      if (connectionReject) {
        connectionReject(error);
        connectionReject = null;
        connectionResolve = null;
      }
    }
  }

  /**
   * Connect to wallet - shows selection modal
   */
  async function connect() {
    // Re-request wallet announcements in case new ones were installed
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // Wait a moment for wallets to announce
    await new Promise(resolve => setTimeout(resolve, 150));

    // If only one wallet, connect directly
    if (detectedWallets.size === 1) {
      const [uuid] = detectedWallets.keys();
      return new Promise((resolve, reject) => {
        connectionResolve = resolve;
        connectionReject = reject;
        selectWallet(uuid);
      });
    }

    // Show wallet selection modal
    return new Promise((resolve, reject) => {
      connectionResolve = resolve;
      connectionReject = reject;
      showWalletModal();
    });
  }

  /**
   * Disconnect wallet
   */
  function disconnect() {
    if (selectedProvider) {
      selectedProvider.removeListener('accountsChanged', handleAccountsChanged);
      selectedProvider.removeListener('chainChanged', handleChainChanged);
    }
    provider = null;
    signer = null;
    address = null;
    connected = false;
    selectedProvider = null;
  }

  /**
   * Switch to Base network
   */
  async function switchToBase() {
    if (!selectedProvider) return;

    try {
      await selectedProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_CHAIN_ID }],
      });
    } catch (switchError) {
      // Chain not added, try to add it
      if (switchError.code === 4902) {
        await selectedProvider.request({
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
   * Send USDC payment to a recipient
   */
  async function sendUSDC(recipientAddress, amount) {
    if (!signer) {
      throw new Error('Wallet not connected');
    }

    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, signer);
    const amountInUnits = toUSDCUnits(amount);

    // Check balance first
    const balance = await usdc.balanceOf(address);
    if (BigInt(balance) < amountInUnits) {
      throw new Error('Insufficient USDC balance');
    }

    // Send transaction
    const tx = await usdc.transfer(recipientAddress, amountInUnits);
    const receipt = await tx.wait(3); // Wait for 3 confirmations (server requires MIN_CONFIRMATIONS = 3)

    return receipt.hash;
  }

  /**
   * Get USDC balance of connected wallet
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
   * Get connected wallet address
   */
  function getAddress() {
    return address;
  }

  /**
   * Check if wallet is connected
   */
  function isConnected() {
    return connected;
  }

  /**
   * Truncate address for display (e.g., "0x1234...5678")
   */
  function truncateAddress(addr) {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  // Initialize EIP-6963 detection on load
  initEIP6963();

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
