"""SAW Plugin: Dice Roller

Contract:
 - main(inputs: dict, params: dict, context) -> dict
 - Each input/output value is: {"data": <value>, "metadata": <dict>}
"""

from __future__ import annotations
import random

def main(inputs: dict, params: dict, context) -> dict:
    # Read configuration from params (manifest declares these under params)
    try:
        num_dice = int((params or {}).get('num_dice', 1))
    except Exception:
        num_dice = 1
    try:
        num_sides = int((params or {}).get('num_sides', 6))
    except Exception:
        num_sides = 6

    num_dice = max(1, num_dice)
    num_sides = max(2, num_sides)

    rolls = [random.randint(1, num_sides) for _ in range(num_dice)]

    # Log the results
    context.log("info", "dice_roller:rolls", rolls=rolls, num_dice=num_dice, num_sides=num_sides)

    return {
        "rolls": {"data": rolls, "metadata": {"count": len(rolls)}}
    }
