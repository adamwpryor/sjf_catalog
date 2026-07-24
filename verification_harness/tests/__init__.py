"""Tests for the verification harness, including the known-defect regression set.

Golden fixtures live in ``fixtures/`` and are **cross-authored**: the author of a module
does not author its fixtures (Design Principle P1). The regression set asserts the harness
independently rediscovers the seeded defects in ``DOUBLE_CHECK.md`` §11.
"""
