"""Sample Python project for testing VS Code Debug Bridge."""



def fibonacci(n):
    """Calculate fibonacci sequence up to n terms."""
    sequence = []
    a, b = 0, 1
    for i in range(n):
        sequence.append(a)
        a, b = b, a + b
    return sequence


def find_primes(limit):
    """Find all prime numbers up to limit."""
    primes = []
    for num in range(2, limit + 1):
        is_prime = True
        for i in range(2, int(num**0.5) + 1):
            if num % i == 0:
                is_prime = False
                break
        if is_prime:
            primes.append(num)
    return primes


def process_users(users):
    """Process a list of user dictionaries."""
    results = []
    for user in users:
        name = user["name"]
        age = user["age"]
        status = "senior" if age >= 60 else "adult" if age >= 18 else "minor"
        results.append({"name": name, "age": age, "status": status})
    return results


def main():
    # Fibonacci
    fib = fibonacci(10)
    print(f"Fibonacci(10): {fib}")

    # Primes
    primes = find_primes(30)
    print(f"Primes up to 30: {primes}")

    # Users
    users = [
        {"name": "Alice", "age": 30},
        {"name": "Bob", "age": 17},
        {"name": "Charlie", "age": 65},
    ]
    processed = process_users(users)
    for u in processed:
        print(f"  {u['name']}: {u['status']}")

    total = sum(fib) + sum(primes)
    print(f"Total: {total}")


if __name__ == "__main__":
    main()
