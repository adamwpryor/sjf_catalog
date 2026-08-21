import os
from typing import Optional

def load_secure_key(key: str, fallback: Optional[str] = None) -> str:
    """Retrieves a sensitive environment variable using a zero-trust approach.

    Prioritizes OS-level environment variables to prevent hardcoded secrets.
    Reads from .env.local as a fallback mechanism if not present in OS env.

    Args:
        key (str): The name of the environment variable to retrieve.
        fallback (Optional[str]): An optional fallback value if the key is not found.

    Returns:
        str: The value of the requested environment variable.

    Raises:
        ValueError: If the key is not found in the environment or .env.local
            and no fallback is provided.

    Example:
        >>> api_key = load_secure_key("API_KEY")
        >>> print("Key loaded")
        'Key loaded'
    """
    val = os.environ.get(key)
    if val:
        return val
        
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env.local')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.startswith(f"{key}="):
                    val = line.split('=', 1)[1].strip()
                    # Strip quotes if present
                    if val.startswith('"') and val.endswith('"'):
                        val = val[1:-1]
                    return val
    
    if fallback is not None:
        return fallback
        
    raise ValueError(f"Secure key '{key}' not found in environment or .env.local")
