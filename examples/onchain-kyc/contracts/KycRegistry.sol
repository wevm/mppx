// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A KYC allowlist an operator maintains onchain. mppx's
/// `Onchain.Server.registry` reads `isVerified` for each payer.
contract KycRegistry {
    /// @notice The operator who may add and remove addresses.
    address public immutable owner;

    /// @notice Whether an address passed KYC.
    mapping(address account => bool) public isVerified;

    event VerificationSet(address indexed account, bool verified);

    error Unauthorized();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Adds or removes an address. Only the operator may call it.
    function setVerified(address account, bool verified) external {
        if (msg.sender != owner) revert Unauthorized();
        isVerified[account] = verified;
        emit VerificationSet(account, verified);
    }
}
