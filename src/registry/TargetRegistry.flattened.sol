// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20 ^0.8.24;

// lib/openzeppelin-contracts/contracts/utils/Context.sol

// OpenZeppelin Contracts (last updated v5.0.1) (utils/Context.sol)

abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {
        return 0;
    }
}

// src/interfaces/ISafeWallet.sol

interface ISafeWallet {
    function getOwners() external view returns (address[] memory);
    function isOwner(address owner) external view returns (bool);
}

// lib/openzeppelin-contracts/contracts/access/Ownable.sol

// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable.sol)

abstract contract Ownable is Context {
    address private _owner;

    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    function owner() public view virtual returns (address) {
        return _owner;
    }

    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

// lib/openzeppelin-contracts/contracts/utils/Pausable.sol

// OpenZeppelin Contracts (last updated v5.3.0) (utils/Pausable.sol)

abstract contract Pausable is Context {
    bool private _paused;

    event Paused(address account);
    event Unpaused(address account);

    error EnforcedPause();
    error ExpectedPause();

    modifier whenNotPaused() {
        _requireNotPaused();
        _;
    }

    modifier whenPaused() {
        _requirePaused();
        _;
    }

    function paused() public view virtual returns (bool) {
        return _paused;
    }

    function _requireNotPaused() internal view virtual {
        if (paused()) {
            revert EnforcedPause();
        }
    }

    function _requirePaused() internal view virtual {
        if (!paused()) {
            revert ExpectedPause();
        }
    }

    function _pause() internal virtual whenNotPaused {
        _paused = true;
        emit Paused(_msgSender());
    }

    function _unpause() internal virtual whenPaused {
        _paused = false;
        emit Unpaused(_msgSender());
    }
}

// lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol

// OpenZeppelin Contracts (last updated v5.1.0) (access/Ownable2Step.sol)

abstract contract Ownable2Step is Ownable {
    address private _pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    function pendingOwner() public view virtual returns (address) {
        return _pendingOwner;
    }

    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
    }

    function _transferOwnership(address newOwner) internal virtual override {
        delete _pendingOwner;
        super._transferOwnership(newOwner);
    }

    function acceptOwnership() public virtual {
        address sender = _msgSender();
        if (pendingOwner() != sender) {
            revert OwnableUnauthorizedAccount(sender);
        }
        _transferOwnership(sender);
    }
}

// src/registry/TargetRegistry.sol

contract TargetRegistry is Ownable2Step, Pausable {
    mapping(address => mapping(bytes4 => bool)) public whitelist;
    mapping(address => uint256) public whitelistedSelectorCount;
    mapping(address => bool) public whitelistedTargets;
    mapping(address => mapping(address => bool)) public allowedERC20TokenRecipients;

    event TargetSelectorAdded(address indexed target, bytes4 indexed selector);
    event TargetSelectorRemoved(address indexed target, bytes4 indexed selector);
    event ERC20TokenRecipientAuthorized(address indexed token, address indexed recipient, bool authorized);

    error InvalidTarget();
    error InvalidSelector();
    error AlreadyWhitelisted();
    error NotWhitelisted();
    error UnauthorizedERC20Transfer(address token, address to);
    error InvalidERC20Token();
    error InvalidRecipient();
    error EmptyBatch();
    error LengthMismatch();

    constructor(address admin) Ownable(admin) {}

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function addToWhitelist(address[] calldata targets, bytes4[] calldata selectors) external onlyOwner whenNotPaused {
        uint256 length = targets.length;
        if (length == 0) revert EmptyBatch();
        if (length != selectors.length) revert LengthMismatch();
        for (uint256 i = 0; i < length;) {
            _addToWhitelist(targets[i], selectors[i]);
            unchecked { ++i; }
        }
    }

    function removeFromWhitelist(address[] calldata targets, bytes4[] calldata selectors) external onlyOwner whenNotPaused {
        uint256 length = targets.length;
        if (length == 0) revert EmptyBatch();
        if (length != selectors.length) revert LengthMismatch();
        for (uint256 i = 0; i < length;) {
            _removeFromWhitelist(targets[i], selectors[i]);
            unchecked { ++i; }
        }
    }

    function addAllowedERC20TokenRecipient(address token, address[] calldata recipients) external onlyOwner whenNotPaused {
        uint256 length = recipients.length;
        for (uint256 i = 0; i < length;) {
            _addAllowedERC20TokenRecipient(token, recipients[i]);
            unchecked { ++i; }
        }
    }

    function removeAllowedERC20TokenRecipient(address token, address[] calldata recipients) external onlyOwner whenNotPaused {
        uint256 length = recipients.length;
        for (uint256 i = 0; i < length;) {
            _removeAllowedERC20TokenRecipient(token, recipients[i]);
            unchecked { ++i; }
        }
    }

    function isERC20TransferAuthorized(address token, address to, address smartWallet) external view returns (bool) {
        return _isAuthorizedRecipient(to, smartWallet, token);
    }

    function _addToWhitelist(address target, bytes4 selector) internal {
        if (target == address(0)) revert InvalidTarget();
        if (selector == bytes4(0)) revert InvalidSelector();
        if (whitelist[target][selector]) revert AlreadyWhitelisted();
        whitelist[target][selector] = true;
        unchecked { whitelistedSelectorCount[target]++; }
        whitelistedTargets[target] = true;
        emit TargetSelectorAdded(target, selector);
    }

    function _removeFromWhitelist(address target, bytes4 selector) internal {
        if (target == address(0)) revert InvalidTarget();
        if (selector == bytes4(0)) revert InvalidSelector();
        if (!whitelist[target][selector]) revert NotWhitelisted();
        whitelist[target][selector] = false;
        unchecked { whitelistedSelectorCount[target]--; }
        if (whitelistedSelectorCount[target] == 0) {
            whitelistedTargets[target] = false;
        }
        emit TargetSelectorRemoved(target, selector);
    }

    function _addAllowedERC20TokenRecipient(address token, address recipient) internal {
        if (token == address(0)) revert InvalidERC20Token();
        if (recipient == address(0)) revert InvalidRecipient();
        if (allowedERC20TokenRecipients[token][recipient]) revert AlreadyWhitelisted();
        allowedERC20TokenRecipients[token][recipient] = true;
        emit ERC20TokenRecipientAuthorized(token, recipient, true);
    }

    function _removeAllowedERC20TokenRecipient(address token, address recipient) internal {
        if (token == address(0)) revert InvalidERC20Token();
        if (recipient == address(0)) revert InvalidRecipient();
        if (!allowedERC20TokenRecipients[token][recipient]) revert NotWhitelisted();
        allowedERC20TokenRecipients[token][recipient] = false;
        emit ERC20TokenRecipientAuthorized(token, recipient, false);
    }

    function _isAuthorizedRecipient(address to, address smartWallet, address token) internal view virtual returns (bool) {
        if (to == smartWallet) return true;
        if (allowedERC20TokenRecipients[token][to]) return true;
        try ISafeWallet(smartWallet).isOwner(to) returns (bool isOwner) {
            if (isOwner) return true;
        } catch {}
        return false;
    }
}
