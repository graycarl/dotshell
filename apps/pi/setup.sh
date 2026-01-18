#!/bin/bash

# Setup pi agent configuration
# Links skills and prompts to ~/.pi/agent/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_DIR="$HOME/.pi/agent"

mkdir -p "$PI_AGENT_DIR"

# Link skills directory
if [ -L "$PI_AGENT_DIR/skills" ]; then
    rm "$PI_AGENT_DIR/skills"
fi
if [ -d "$SCRIPT_DIR/agent/skills" ]; then
    ln -s "$SCRIPT_DIR/agent/skills" "$PI_AGENT_DIR/skills"
    echo "✓ Linked skills -> $PI_AGENT_DIR/skills"
fi

# Link prompts directory
if [ -L "$PI_AGENT_DIR/prompts" ]; then
    rm "$PI_AGENT_DIR/prompts"
fi
if [ -d "$SCRIPT_DIR/agent/prompts" ]; then
    ln -s "$SCRIPT_DIR/agent/prompts" "$PI_AGENT_DIR/prompts"
    echo "✓ Linked prompts -> $PI_AGENT_DIR/prompts"
fi

# Link APPEND_SYSTEM.md file
if [ -L "$PI_AGENT_DIR/APPEND_SYSTEM.md" ]; then
    rm "$PI_AGENT_DIR/APPEND_SYSTEM.md"
fi
if [ -f "$SCRIPT_DIR/agent/APPEND_SYSTEM.md" ]; then
    ln -s "$SCRIPT_DIR/agent/APPEND_SYSTEM.md" "$PI_AGENT_DIR/APPEND_SYSTEM.md"
    echo "✓ Linked APPEND_SYSTEM.md -> $PI_AGENT_DIR/APPEND_SYSTEM.md"
fi

# Link keybinddings.json file
if [ -L "$PI_AGENT_DIR/keybindings.json" ]; then
    rm "$PI_AGENT_DIR/keybindings.json"
fi
if [ -f "$SCRIPT_DIR/agent/keybindings.json" ]; then
    ln -s "$SCRIPT_DIR/agent/keybindings.json" "$PI_AGENT_DIR/keybindings.json"
    echo "✓ Linked keybindings.json -> $PI_AGENT_DIR/keybindings.json"
fi

echo "Setup complete!"
