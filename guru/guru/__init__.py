"""Guru: MAATAA's own language model family, built from scratch.

guru-maataa-nano / -mini / -small train on a Mac (Apple GPU); base-1b and 7b
configurations are for rented GPUs. The weights use the Llama tensor layout,
so trained models convert to GGUF with llama.cpp and run in Ollama.
"""
__version__ = "0.1.0"
