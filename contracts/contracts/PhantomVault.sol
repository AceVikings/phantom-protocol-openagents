// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title  PhantomVault
 * @notice Escrow contract for the Phantom Protocol deal lifecycle.
 *         Settles in native ETH — no token approvals required.
 *
 * Flow:
 *   1. Buyer calls deposit(dealKey, seller, lockDuration) with msg.value
 *      - ETH is held in this contract
 *      - Emits Locked(dealKey, buyer, seller, amount, expiresAt)
 *      - The resulting tx hash is stored in the backend as deal.lockTxHash
 *
 *   2. After 0G verification passes, the protocol operator calls release(dealKey)
 *      - ETH is forwarded to the seller's ephemeral address
 *      - Emits Released(dealKey, seller, amount)
 *
 *   3. On deal failure/dispute the operator calls refund(dealKey)
 *      - ETH is returned to the buyer
 *      - Emits Refunded(dealKey, buyer, amount)
 *
 *   4. If the operator is unresponsive after expiry, the buyer can call
 *      claimExpiredRefund(dealKey) to self-recover funds.
 *
 * DealId mapping:
 *   Backend deal IDs are UUID strings. Convert to bytes32 with:
 *     ethers.keccak256(ethers.toUtf8Bytes(dealId))
 *   The same conversion is used in scripts/deploy.js helpers.
 */
contract PhantomVault is Ownable, ReentrancyGuard {
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
        uint256 amount;     // ETH amount in wei
        DealStatus status;
        uint256 lockedAt;
        uint256 expiresAt;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

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
     * @param _operator Protocol wallet address that calls release/refund
     */
    constructor(address _operator) Ownable(msg.sender) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External — buyer
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Lock ETH for a deal. Send the deal amount as msg.value.
     * @param dealKey      keccak256(utf8(dealId)) — the backend UUID converted to bytes32
     * @param seller       Seller's ephemeral Ethereum address (receives ETH on release)
     * @param lockDuration Escrow duration in seconds (MIN_LOCK_DURATION..MAX_LOCK_DURATION)
     */
    function deposit(
        bytes32 dealKey,
        address seller,
        uint256 lockDuration
    ) external payable nonReentrant {
        if (deals[dealKey].status != DealStatus.None) revert DealAlreadyExists();
        if (msg.value == 0) revert ZeroAmount();
        if (seller == address(0)) revert ZeroAddress();
        if (lockDuration < MIN_LOCK_DURATION || lockDuration > MAX_LOCK_DURATION) {
            revert LockDurationOutOfRange();
        }

        uint256 expiresAt = block.timestamp + lockDuration;

        deals[dealKey] = Deal({
            buyer: msg.sender,
            seller: seller,
            amount: msg.value,
            status: DealStatus.Locked,
            lockedAt: block.timestamp,
            expiresAt: expiresAt
        });

        emit Locked(dealKey, msg.sender, seller, msg.value, expiresAt);
    }

    /**
     * @notice Buyer self-recovers ETH after the lock has expired and the
     *         operator has not yet acted.
     */
    function claimExpiredRefund(bytes32 dealKey) external nonReentrant {
        Deal storage deal = deals[dealKey];
        if (deal.status == DealStatus.None) revert DealNotFound();
        if (deal.status != DealStatus.Locked) revert DealNotLocked();
        if (block.timestamp < deal.expiresAt) revert DealNotExpired();
        if (msg.sender != deal.buyer) revert NotAuthorized();

        deal.status = DealStatus.Refunded;
        uint256 amount = deal.amount;
        (bool ok, ) = deal.buyer.call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit Refunded(dealKey, deal.buyer, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External — operator / owner
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Release escrowed ETH to the seller after successful deal completion.
     *         Called by the protocol operator once 0G verification passes.
     */
    function release(bytes32 dealKey) external nonReentrant onlyOperator {
        Deal storage deal = deals[dealKey];
        if (deal.status == DealStatus.None) revert DealNotFound();
        if (deal.status != DealStatus.Locked) revert DealNotLocked();
        if (block.timestamp > deal.expiresAt) revert DealExpired();

        deal.status = DealStatus.Released;
        uint256 amount = deal.amount;
        (bool ok, ) = deal.seller.call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit Released(dealKey, deal.seller, amount);
    }

    /**
     * @notice Refund escrowed ETH to the buyer on deal failure or dispute.
     *         Called by the protocol operator.
     */
    function refund(bytes32 dealKey) external nonReentrant onlyOperator {
        Deal storage deal = deals[dealKey];
        if (deal.status == DealStatus.None) revert DealNotFound();
        if (deal.status != DealStatus.Locked) revert DealNotLocked();

        deal.status = DealStatus.Refunded;
        uint256 amount = deal.amount;
        (bool ok, ) = deal.buyer.call{value: amount}("");
        require(ok, "ETH transfer failed");

        emit Refunded(dealKey, deal.buyer, amount);
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
