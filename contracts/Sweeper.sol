// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IERC721 {
    function safeTransferFrom(address, address, uint256) external;
}

interface IERC1155 {
    function safeBatchTransferFrom(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external;
}

/// @notice One-shot sweeper. Deployed by an EOA; in the constructor it forwards
/// every listed ERC20 / ERC721 / ERC1155 balance plus all native ETH held at
/// this contract address to `to`, then returns empty runtime bytecode so nothing
/// is persisted on-chain.
///
/// Funding model: pre-compute this contract's deployment address (CREATE uses
/// `keccak256(rlp(deployer, nonce))[12:]`) and pre-send assets to it, OR deploy
/// it inside an atomic bundle alongside the transfers that fund it.
contract Sweeper {
    struct NFT721  { address token; uint256[] ids; }
    struct NFT1155 { address token; uint256[] ids; uint256[] amounts; }

    constructor(
        address payable to,
        address[] memory erc20s,
        NFT721[] memory erc721s,
        NFT1155[] memory erc1155s
    ) payable {
        require(to != address(0), "zero dest");

        // ERC20: pull full balance for each listed token.
        for (uint256 i; i < erc20s.length; ++i) {
            uint256 bal = IERC20(erc20s[i]).balanceOf(address(this));
            if (bal == 0) continue;
            (bool ok, bytes memory ret) = erc20s[i].call(
                abi.encodeWithSelector(IERC20.transfer.selector, to, bal)
            );
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "erc20 xfer");
        }

        // ERC721: move each listed tokenId.
        for (uint256 i; i < erc721s.length; ++i) {
            for (uint256 j; j < erc721s[i].ids.length; ++j) {
                IERC721(erc721s[i].token).safeTransferFrom(address(this), to, erc721s[i].ids[j]);
            }
        }

        // ERC1155: batch-move per collection.
        for (uint256 i; i < erc1155s.length; ++i) {
            IERC1155(erc1155s[i].token).safeBatchTransferFrom(
                address(this), to, erc1155s[i].ids, erc1155s[i].amounts, ""
            );
        }

        // ETH last so any failed pre-step doesn't lock funds in an empty-code shell.
        uint256 ethBal = address(this).balance;
        if (ethBal > 0) {
            (bool ok, ) = to.call{value: ethBal}("");
            require(ok, "eth xfer");
        }

        // Deploy as empty runtime — saves the runtime-storage gas cost.
        // safeTransferFrom callbacks above are skipped by the token contracts
        // because `address(this).code.length == 0` while the constructor runs.
        assembly { return(0, 0) }
    }
}
