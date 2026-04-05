// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice EIP-3009 interface for gasless authorized transfers (USDC native)
interface IERC20WithAuthorization {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @notice ERC-8183 hook interface
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// @title PaymentHook
/// @notice ERC-8183 hook that executes x402/MPP payment authorizations during fund().
///
/// @dev Makes the client's payment atomic with escrow funding:
///   1. Hook executes client's transferWithAuthorization (client → gateway)
///   2. fund() runs its normal safeTransferFrom (gateway → escrow)
///   Net effect: client → escrow in one transaction. No gateway float.
///
/// For x402: client signs EIP-3009 authorization off-chain. Hook executes it.
/// For MPP "transaction" type: gateway submits the signed tx before calling fund().
///   The hook is not needed — gateway already has the USDC when fund() runs.
/// For MPP "hash" type: client already paid on-chain. Same as above.
///
/// The gateway must have a standing USDC approval for the 8183 contract
/// (one-time setup: approve(acp8183, type(uint256).max)).
contract PaymentHook is IACPHook {
    IERC20WithAuthorization public immutable token;

    /// @notice Payment type identifiers encoded as first byte of optParams
    uint8 public constant TYPE_NONE = 0;      // Normal ACP flow, no hook action
    uint8 public constant TYPE_EIP3009 = 1;   // x402: transferWithAuthorization
    uint8 public constant TYPE_DIRECT = 2;    // MPP: gateway already has USDC

    event PaymentExecuted(
        uint256 indexed jobId,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint8 paymentType
    );

    constructor(address _token) {
        token = IERC20WithAuthorization(_token);
    }

    /// @notice Intercepts fund() to execute the client's payment authorization.
    /// @dev Only acts on fund() calls. Decodes optParams to determine payment type.
    ///      For EIP-3009: executes transferWithAuthorization (client → gateway).
    ///      For DIRECT: no-op (gateway already has USDC from MPP transfer).
    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external override {
        // Only intercept fund()
        if (selector != bytes4(keccak256("fund(uint256,bytes)"))) return;

        // Skip if no optParams
        if (data.length == 0) return;

        uint8 paymentType = uint8(bytes1(data[0:1]));

        if (paymentType == TYPE_EIP3009) {
            // x402: decode and execute transferWithAuthorization
            (
                address from,
                uint256 value,
                uint256 validAfter,
                uint256 validBefore,
                bytes32 nonce,
                bytes memory signature
            ) = abi.decode(data[1:], (address, uint256, uint256, uint256, bytes32, bytes));

            // Execute: client → gateway (msg.sender)
            // Then fund() will move: gateway → escrow
            token.transferWithAuthorization(
                from,           // client wallet
                msg.sender,     // gateway wallet
                value,
                validAfter,
                validBefore,
                nonce,
                signature
            );

            emit PaymentExecuted(jobId, from, msg.sender, value, paymentType);
        }
        // TYPE_DIRECT: no action needed, gateway already has USDC
        // TYPE_NONE: no action needed, normal ACP flow
    }

    function afterAction(
        uint256, /* jobId */
        bytes4, /* selector */
        bytes calldata /* data */
    ) external override {
        // No-op
    }
}
