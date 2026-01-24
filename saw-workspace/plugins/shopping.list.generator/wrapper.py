import random

def main(inputs: dict, params: dict, context) -> dict:
    context.log("info", "shopping_list_generator:start")
    
    meals = {
        "Spaghetti Bolognese": ["spaghetti", "ground beef", "tomato sauce", "onion", "garlic"],
        "Chicken Curry": ["chicken", "curry powder", "coconut milk", "rice", "vegetables"],
        "Tacos": ["taco shells", "ground beef", "lettuce", "cheese", "tomato", "salsa"],
        "Caesar Salad": ["romaine lettuce", "croutons", "Caesar dressing", "parmesan cheese", "chicken"],
    }
    
    meal = random.choice(list(meals.keys()))
    ingredients = meals[meal]
    
    return {"result": {"meal": meal, "ingredients": ingredients}, "metadata": {}}