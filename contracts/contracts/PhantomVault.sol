// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  PhantomVault
 * @notice Escrow contract for the Phantom Protocol deal lifecycle.
 *
 * Flow:
 *   1. Buyer calls deposit(dealId, seller, amount, lockDuration)
 *      - USDC is pulled from buyer into this contract
 *      - Emits Locked(dealId, buyer, seller, amount, expiresAt)
 *      - The resulting tx hash is stored in the backend as deal.lockTxHash
 *
 *   2. After 0G verification passes, the protocol operator calls release(dealId)
 *      - USDC is forwarded to the seller's ephemeral address
 *      - Emits Released(dealId, seller, amount)
 *
 *   3. On deal failure/dispute the operator calls refund(dealId)
 *      - USDC is returned to the buyer
 *      - Emits Refunded(dealId, buyer, amount)
 *
 *   4. If the operator is unresponsive after expiry, the buyer can call
 *      claimExpiredRefund(dealId) to self-recover funds.
 *
 * DealId mapping:
 *   Backend deal IDs are UUID strings. Convert to bytes32 with:
 *     ethers.keccak256(ethers.toUtf8Bytes(dealId))
 *   The same conversion is used in scripts/deploy.js helpers.
 *
 * USDC on Sepolia: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 (Circle testnet)
 */
contract PhantomVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────

    enum DealStatus {
        None,      // deal not deposited
        Locked,    // funds held in escrow
        Released,  // funds sent to seller
        Refunded   // funds returned to buyer
    }

    struct Deal {
        address buyer;
        address seller;
        uint256 amount;     // USDC amount (6 decimals)
        DealStatus status;
        uint256 lockedAt;
        uint256 expiresAt;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    address public operator;

    /// @dev bytes32 key = keccak256(utf8(dealId))
    mapping(bytes32 => Deal) public deals;

    uint256 public constant MAX_LOCK_DURATION = 7 days;
    uint256 public constant MIN_LOCK_DURATION = 5 minutes;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event Locked(
        bytes32 indexed dealKey,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 expiresAt
    );
    event Released(bytes32 indexed dealKey, address indexed seller, uint256 amount);
    event Refunded(bytes32 indexed dealKey, address indexed buyer, uint256 amount);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error DealAlreadyExists();
    error DealNotFound();
    error DealNotLocked();
    error NotAuthorized();
    error DealExpired();
    error DealNotExpired();
    error ZeroAmount();
    error ZeroAddress();
    error LockDurationOutOfRange();

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert NotAuthorized();
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param _usdc     ERC-20 token used for settlement (USDC, 6 decimals)
     * @param _operator Protocol wallet address that calls release/refund
     */
    constructor(address _usdc, address _operator) Ownable(msg.sender) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_operator == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        operator = _operator;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External — buyer
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Lock USDC for a deal. Caller must have approved this contract first.
     * @param dealKey      keccak256(utf8(dealId)) — the backend UUID converted to bytes32
     * @param seller       Seller's ephemeral Ethereum address (receives funds on release)
     * @param amount       USDC amount in base units (6 decimals)
     * @param lockDuration Escrow duration in seconds (clamped to MIN/MAX_LOCK_DURATION)
     */
    function deposit(
        bytes32 dealKey,
        address seller,
        uint256 amount,
        uint256 lockDuration
    ) external nonReentrant {
        if (deals[dealKey].status != DealStatus.None) revert DealAlreadyExists();
        if (amount == 0) revert ZeroAmount();
        if (seller == address(0)) revert ZeroAddress();
        if (lockDuration < MIN_LOCK_DURATION || lockDuration > MAX_LOCK_DURATION) {
            revert LockDurationOutOfRange();
        }

        uint256 expiresAt = block.timestamp + lockDuration;

        deals[dealKey] = Deal({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            status: DealStatus.Locked,
            lockedAt: block.timestamp,
            expiresAt: expiresAt
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(dealKey, msg.sender, seller, amount, expiresAt);
    }

    /**
     * @notice Buyer self-recovers funds after the lock has expired and the
     *         operator has not yet acted.
     */
    function claimExpiredRefund(bytes32 dealKey) external nonReentrant {
        Deal storage deal = deals[dealKey];
        if (deal.status == DealStatus.None) revert DealNotFound();
        if (deal.status != DealStatus.Locked) revert DealNotLocked();
        if (block.timestamp < deal.expiresAt) revert DealNotExpired();
        if (msg.sender != deal.buyer) revert NotAuthorized();

        deal.status = DealStatus.Refunded;
        usdc.safeTransfer(deal.buyer, deal.amount);

        emit Refunded(dealKey, deal.buyer, deal.amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External — operator / owner
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Release escrowed funds to the seller after successful deal completion.
     *         Called by the protocol operator once 0G verification passes.
     */
    function release(bytes32 dealKey) external nonReentrant onlyOperator {
        Deal storage deal = deals[dealKey];
        if (deal.status == DealStatus.None) revert DealNotFound();
        if (deal.status != DealStatus.Locked) revert DealNotLocked();
        if (block.timestamp > deal.expiresAt) revert DealExpired();

        deal.status = DealStatus.Released;
        usdc.safeTransfer(deal.seller, deal.amount);

        emit Released(dealKey, deal.seller, deal.amount);
    }

    /**
     * @notice Refund escrowed funds to the buyer on deal failure or dispute.
     *         Called by the protocol operator.
     */
    function refund(bytes32 dealKey) external nonReentrant onlyOperator {
        Deal storage deal = deals[dealKey];
        if (deal.status == DealStatus.None) revert DealNotFound();
        if (deal.status != DealStatus.Locked) revert DealNotLocked();

        deal.status = DealStatus.Refunded;
        usdc.safeTransfer(deal.buyer, deal.amount);

        emit Refunded(dealKey, deal.buyer, deal.amount);
    }

    /**
     * @notice Transfer the operator role to a new address.
     */
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Return full deal struct for a given dealKey.
     */
    function getDeal(bytes32 dealKey) external view returns (Deal memory) {
        return deals[dealKey];
    }

    /**
     * @notice Convenience: derive the bytes32 key used on-chain from a UUID string.
     *         Equivalent to ethers.keccak256(ethers.toUtf8Bytes(dealId)) off-chain.
     */
    function dealKeyFor(string calldata dealId) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(dealId));
    }
}
