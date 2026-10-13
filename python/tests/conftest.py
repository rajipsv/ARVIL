import sys

# langchain_core optionally imports transformers (and with it torch) for token counting.
# The tests never need it; blocking the import keeps them fast and light on memory.
sys.modules.setdefault("transformers", None)
