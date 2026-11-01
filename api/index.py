"""Vercel entry point: every /api/* request is rewritten here (see vercel.json)."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from lib.app import app  # noqa: E402,F401  (WSGI callable Vercel looks for)
