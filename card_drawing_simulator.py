import random

class Card:
    SUITS = ['Hearts', 'Diamonds', 'Clubs', 'Spades']
    RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace']

    def __init__(self, suit, rank):
        self.suit = suit
        self.rank = rank

    def __str__(self):
        return f"{self.rank} of {self.suit}"


class Deck:
    def __init__(self):
        self.cards = [Card(suit, rank) for suit in Card.SUITS for rank in Card.RANKS]
        self.shuffle()

    def shuffle(self):
        random.shuffle(self.cards)

    def draw(self):
        if self.cards:
            return self.cards.pop()
        else:
            raise Exception("No cards left in the deck!")

    def reset(self):
        self.cards = [Card(suit, rank) for suit in Card.SUITS for rank in Card.RANKS]
        self.shuffle()

    def remaining_cards(self):
        return len(self.cards)


# Example usage
if __name__ == "__main__":
    deck = Deck()
    print(f"Remaining cards: {deck.remaining_cards()}")
    try:
        while True:
            card = deck.draw()
            print(f"Drew: {card}")
            print(f"Remaining cards: {deck.remaining_cards()}")
    except Exception as e:
        print(e)