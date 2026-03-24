from __future__ import annotations

ERROR_TYPES = [
    "synced_ts",
    "receive_ts",
    "player_id",
    "receiver_id",
    "spadl_type",
    "outcome",
    "false_positive",
    "missing",
]

# Canonical + frequently observed SPADL action types.
SPADL_TYPES = [
    # Open-play
    "pass",
    "cross",
    "take_on",
    "foul",
    "tackle",
    "interception",
    "shot",
    "keeper_save",
    "keeper_claim",
    "keeper_punch",
    "keeper_pick_up",
    "clearance",
    "bad_touch",
    "non_action",
    "dribble",
    "ball_recovery",
    "dispossessed",
    # Set-piece
    "throw_in",
    "goalkick",
    # Alias in some pipelines
    "goal_kick",
    "corner_short",
    "corner_crossed",
    "freekick_short",
    "freekick_crossed",
    "shot_freekick",
    "shot_penalty",
]

# Types that require receiver timestamp for alignment validation.
PASS_LIKE_TYPES = {
    # Open-play pass-like
    "pass",
    "cross",
    "shot",
    "clearance",
    "keeper_punch",
    "shot_block",
    # Set-piece pass-like
    "throw_in",
    "goalkick",
    "goal_kick",
    "corner_short",
    "corner_crossed",
    "freekick_short",
    "freekick_crossed",
    "shot_freekick",
    "shot_penalty",
}

# Extended list used by UI dropdown.
SPADL_EXTENDED_TYPES = sorted(set(SPADL_TYPES + ["shot_block"]))
