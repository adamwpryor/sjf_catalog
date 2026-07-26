"""Enable ``python -m verification_harness`` → the pipeline in :mod:`verification_harness.cli`."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
