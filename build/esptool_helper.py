"""PyInstaller entry point for the ESP32 flashing helper."""
from esptool import main

if __name__ == "__main__":
    raise SystemExit(main())
