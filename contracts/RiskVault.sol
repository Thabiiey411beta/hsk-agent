// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RiskVault — on-chain risk policy for the HSK verifiable trading agent.
/// @notice Minimal and auditable: holds the caps the agent must obey.
/// The agent reads these values every poll and enforces the TIGHTER of the
/// on-chain caps vs its local config. The owner (Newton) can tighten or
/// loosen caps; every change emits an event, so cap changes are themselves
/// part of the audit trail. This contract holds NO funds and makes NO trades —
/// it is a policy registry, not a vault of assets (name kept for the hackathon
/// "vault" framing; it never custodies tokens).
/// @notice Minimal Uniswap V3 pool surface exitIfBreached() needs.
interface IPool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

contract RiskVault {
    address public owner;
    address public agent;

    /// @notice Max fraction of equity per trade, in basis points (1000 = 10%).
    uint256 public perTradeCapBps;
    /// @notice Max fraction of equity deployed per day, in bps.
    uint256 public dailyCapBps;
    /// @notice Stop-loss per position, in bps.
    uint256 public stopLossBps;
    /// @notice Max drawdown from equity peak, in bps — breaching halts trading.
    uint256 public maxDrawdownBps;
    /// @notice Daily loss limit, in bps.
    uint256 public dailyLossLimitBps;

    bool public halted;

    /// @notice TWAP window (seconds) exitIfBreached() observes — 5 minutes.
    uint256 internal constant VAULT_TWAP_WINDOW = 300;

    // --- v2 additions (2026-11-23) ---
    /// @notice HSKSwap pool used for the on-chain stop. v2 pointed at the
    /// demo USDT/WHSK pool (token0 = USDT, token1 = WHSK, both 18 decimals).
    /// v3 (2026-11-23) points at the fairly-priced tWHSK/tUSDT pool — see
    /// poolKind below. Set by the owner.
    address public pool;
    /// @notice Which pool layout exitIfBreached() prices:
    ///   0 = demo USDT/WHSK (token0 = USDT 18 dec, token1 = WHSK 18 dec).
    ///   1 = tWHSK/tUSDT (token0 = tWHSK 18 dec, token1 = tUSDT 6 dec).
    /// @dev poolKind MUST match pool: v2's _priceFromTick assumes kind 0, and
    /// pointing a kind-0 vault at the t-pool would compute ~1.15e13 USDT/WHSK
    /// (1.0001^300757) — a stop that can never fire. That silent failure is
    /// why kind exists instead of re-pointing v2 as-is.
    uint8 public poolKind;
    /// @notice Journal batch anchors: batchId => keccak256 hash of the batch.
    mapping(uint256 => bytes32) public anchors;
    uint256 public anchorCount;

    struct Position {
        /// @notice Entry price, USDT per WHSK scaled by 1e18.
        uint256 entryPrice;
        /// @notice Stop price, USDT per WHSK scaled by 1e18. Exit triggers
        /// when BOTH the 5-min TWAP and spot are at or below this level.
        uint256 stopPrice;
        bool exitTriggered;
        bool exists;
    }
    mapping(bytes32 => Position) public positions;

    event PoolSet(address indexed pool);
    event PoolKindSet(uint8 indexed poolKind);
    event Anchored(uint256 indexed batchId, bytes32 indexed batchHash);
    event PositionRegistered(bytes32 indexed id, uint256 entryPrice, uint256 stopPrice);
    event ExitTriggered(bytes32 indexed id, uint256 twapPrice, uint256 spotPrice, uint256 stopPrice);

    event CapsUpdated(uint256 perTradeCapBps, uint256 dailyCapBps, uint256 stopLossBps, uint256 maxDrawdownBps, uint256 dailyLossLimitBps);
    event Halted(string reason);
    event Resumed();
    event AgentSet(address indexed agent);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    modifier onlyOwnerOrAgent() {
        require(msg.sender == owner || msg.sender == agent, "not owner/agent");
        _;
    }

    constructor(
        address _agent,
        uint256 _perTradeCapBps,
        uint256 _dailyCapBps,
        uint256 _stopLossBps,
        uint256 _maxDrawdownBps,
        uint256 _dailyLossLimitBps
    ) {
        owner = msg.sender;
        agent = _agent;
        perTradeCapBps = _perTradeCapBps;
        dailyCapBps = _dailyCapBps;
        stopLossBps = _stopLossBps;
        maxDrawdownBps = _maxDrawdownBps;
        dailyLossLimitBps = _dailyLossLimitBps;
        emit CapsUpdated(_perTradeCapBps, _dailyCapBps, _stopLossBps, _maxDrawdownBps, _dailyLossLimitBps);
    }

    function setAgent(address _agent) external onlyOwner {
        agent = _agent;
        emit AgentSet(_agent);
    }

    /// @notice Set the HSKSwap pool exitIfBreached() reads. Call setPoolKind
    /// to match whenever the pool layout changes — a mismatched kind makes
    /// the stop silently never fire (see poolKind docs).
    function setPool(address _pool) external onlyOwner {
        require(_pool != address(0), "pool zero");
        pool = _pool;
        emit PoolSet(_pool);
    }

    /// @notice Set the pool layout kind (0 = demo USDT/WHSK 18/18,
    /// 1 = tWHSK/tUSDT 18/6). Only 0 and 1 exist.
    function setPoolKind(uint8 _kind) external onlyOwner {
        require(_kind <= 1, "bad kind");
        poolKind = _kind;
        emit PoolKindSet(_kind);
    }

    /// @notice Anchor a journal batch hash on-chain (verifiability trail).
    /// Callable by owner or agent; batchIds are sequential, starting at 0.
    function anchor(bytes32 batchHash) external onlyOwnerOrAgent returns (uint256 batchId) {
        require(batchHash != bytes32(0), "zero hash");
        batchId = anchorCount;
        anchors[batchId] = batchHash;
        anchorCount += 1;
        emit Anchored(batchId, batchHash);
    }

    /// @notice Register a position for the permissionless stop. Prices are
    /// USDT per WHSK scaled by 1e18 (e.g. 78.24 USDT/WHSK = 78.24e18).
    function registerPosition(bytes32 id, uint256 entryPrice, uint256 stopPrice) external onlyOwnerOrAgent {
        require(entryPrice > 0 && stopPrice > 0, "zero price");
        require(stopPrice < entryPrice, "stop must be below entry");
        positions[id] = Position({ entryPrice: entryPrice, stopPrice: stopPrice, exitTriggered: false, exists: true });
        emit PositionRegistered(id, entryPrice, stopPrice);
    }

    /// @notice 1.0001^n scaled by 1e18 (exponentiation by squaring). Only
    /// used for realistic testnet ticks (|tick| <= ~400k); extreme ticks
    /// overflow and revert, which is fail-closed (no exit is triggered).
    function _pow10001(uint256 n) internal pure returns (uint256) {
        uint256 result = 1e18;
        uint256 base = 10001e14; // 1.0001 * 1e18
        while (n > 0) {
            if ((n & 1) == 1) result = (result * base) / 1e18;
            base = (base * base) / 1e18;
            n >>= 1;
        }
        return result;
    }

    /// @notice USDT per WHSK (1e18 scale) from a pool tick. Dispatches on
    /// poolKind:
    ///   kind 0 (demo, token0 = USDT, token1 = WHSK, both 18 dec):
    ///     price = 1.0001^(-tick).
    ///   kind 1 (t-pool, token0 = tWHSK 18 dec, token1 = tUSDT 6 dec):
    ///     price = 1.0001^tick * 10^(18-6) = 1.0001^tick * 1e12 tUSDT/tWHSK.
    ///     Scaled 1e18: tick < 0 -> 1e48 / _pow10001(|tick|);
    ///     tick >= 0 -> 1e12 * _pow10001(tick).
    ///     (tick -300757 -> ~8.69e16 = 0.0869 USDT/WHSK — verified against
    ///     the live QuoterV2-implied price, not just the formula.)
    function _priceFromTick(int24 tick) internal view returns (uint256) {
        if (poolKind == 1) {
            if (tick >= 0) {
                // price = 1.0001^tick * 1e12; scaled 1e18 = 1e12 * _pow10001(tick).
                return 1e12 * _pow10001(uint256(int256(tick)));
            }
            // price = 1e12 / 1.0001^|tick|; scaled 1e18 = 1e48 / _pow10001(|tick|).
            return 1e48 / _pow10001(uint256(-int256(tick)));
        }
        if (tick >= 0) {
            // price = 1 / 1.0001^tick
            return (1e36) / _pow10001(uint256(int256(tick)));
        }
        // price = 1.0001^|tick|
        return _pow10001(uint256(-int256(tick)));
    }

    /// @notice Avow-style permissionless settle: anyone may call this; it
    /// succeeds (and flags the position) ONLY when BOTH the pool's 5-minute
    /// TWAP and its spot price are at or below the registered stop price.
    /// v2 moves NO funds — the vault holds none — it emits ExitTriggered and
    /// sets exitTriggered so the agent's loop can act on it. If the pool is
    /// unset, the position is unknown, or either price is above the stop,
    /// the call reverts (no state change, no false exit).
    function exitIfBreached(bytes32 positionId) external {
        require(pool != address(0), "pool unset");
        Position storage pos = positions[positionId];
        require(pos.exists, "unknown position");
        require(!pos.exitTriggered, "already triggered");
        IPool p = IPool(pool);
        (int56[] memory cumulatives, ) = p.observe(_twapSecondsAgos());
        int56 meanTick56 = (cumulatives[1] - cumulatives[0]) / int56(uint56(VAULT_TWAP_WINDOW));
        int24 meanTick = int24(meanTick56);
        (, int24 spotTick, , , , , ) = p.slot0();
        uint256 twapPrice = _priceFromTick(meanTick);
        uint256 spotPrice = _priceFromTick(spotTick);
        require(twapPrice <= pos.stopPrice && spotPrice <= pos.stopPrice, "stop not breached");
        pos.exitTriggered = true;
        emit ExitTriggered(positionId, twapPrice, spotPrice, pos.stopPrice);
    }

    function _twapSecondsAgos() internal pure returns (uint32[] memory arr) {
        arr = new uint32[](2);
        arr[0] = uint32(VAULT_TWAP_WINDOW);
        arr[1] = 0;
    }

    function setCaps(
        uint256 _perTradeCapBps,
        uint256 _dailyCapBps,
        uint256 _stopLossBps,
        uint256 _maxDrawdownBps,
        uint256 _dailyLossLimitBps
    ) external onlyOwner {
        require(_perTradeCapBps <= 2500, "per-trade cap > 25%");
        require(_dailyCapBps <= 10000, "daily cap > 100%");
        require(_stopLossBps <= 1000, "stop-loss > 10%");
        perTradeCapBps = _perTradeCapBps;
        dailyCapBps = _dailyCapBps;
        stopLossBps = _stopLossBps;
        maxDrawdownBps = _maxDrawdownBps;
        dailyLossLimitBps = _dailyLossLimitBps;
        emit CapsUpdated(_perTradeCapBps, _dailyCapBps, _stopLossBps, _maxDrawdownBps, _dailyLossLimitBps);
    }

    function halt(string calldata reason) external onlyOwnerOrAgent {
        halted = true;
        emit Halted(reason);
    }

    function resume() external onlyOwner {
        halted = false;
        emit Resumed();
    }

    function caps()
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, bool)
    {
        return (perTradeCapBps, dailyCapBps, stopLossBps, maxDrawdownBps, dailyLossLimitBps, halted);
    }
}
