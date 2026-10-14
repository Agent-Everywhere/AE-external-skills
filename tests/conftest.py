"""Keep test runs from writing bytecode into the repo (the plugin folder must stay free of __pycache__)."""
import os
import sys

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"   # child processes (the scripts under test) inherit it
