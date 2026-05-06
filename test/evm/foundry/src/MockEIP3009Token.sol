// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MockERC20 } from "./MockERC20.sol";

contract MockEIP3009Token is MockERC20 {
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    constructor(string memory name_, string memory symbol_, uint8 decimals_, string memory version_)
        MockERC20(name_, symbol_, decimals_)
    {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name_)),
                keccak256(bytes(version_)),
                block.chainid,
                address(this)
            )
        );
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp >= validAfter, "EIP3009: authorization not yet valid");
        require(block.timestamp <= validBefore, "EIP3009: authorization expired");
        require(!authorizationState[from][nonce], "EIP3009: authorization already used");

        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = ecrecover(digest, v, r, s);

        require(signer != address(0), "EIP3009: invalid signature");
        require(signer == from, "EIP3009: signer mismatch");

        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}
