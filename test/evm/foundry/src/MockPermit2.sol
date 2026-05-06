// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract MockPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32,
        string calldata,
        bytes calldata
    ) external {
        require(block.timestamp <= permit.deadline, "Permit2: expired");
        require(transferDetails.requestedAmount <= permit.permitted.amount, "Permit2: amount too high");
        require(
            IERC20(permit.permitted.token).transferFrom(
                owner, transferDetails.to, transferDetails.requestedAmount
            ),
            "Permit2: transfer failed"
        );
    }

    function permitBatchWitnessTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32,
        string calldata,
        bytes calldata
    ) external {
        require(block.timestamp <= permit.deadline, "Permit2: expired");
        require(transferDetails.length == permit.permitted.length, "Permit2: length mismatch");
        for (uint256 i = 0; i < transferDetails.length; i++) {
            require(
                transferDetails[i].requestedAmount <= permit.permitted[i].amount,
                "Permit2: amount too high"
            );
            require(
                IERC20(permit.permitted[i].token).transferFrom(
                    owner, transferDetails[i].to, transferDetails[i].requestedAmount
                ),
                "Permit2: transfer failed"
            );
        }
    }
}
