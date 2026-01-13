from __future__ import annotations
import random

class Deck:
    def __init__(self):
        ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
        suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades']
        self.cards = [f'{rank} of {suit}' for suit in suits for rank in ranks]
        self.drawn_cards = []

    def draw_card(self):
        if not self.cards:
            raise ValueError('No more cards to draw')
        card = random.choice(self.cards)
        self.cards.remove(card)
        self.drawn_cards.append(card)
        return card

    def get_remaining_cards(self):
        return len(self.cards)

def main(inputs: dict, params: dict, context) -> dict:
    deck = Deck()
    drawn = deck.draw_card()
    remaining = deck.get_remaining_cards()
    context.log('info', 'deck_of_cards:draw_card', drawn=drawn, remaining=remaining)
    return {'deck': {'data': deck.cards, 'metadata': {}}, 'drawn': {'data': drawn, 'metadata': {'remaining': remaining}}}