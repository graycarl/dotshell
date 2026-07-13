#!/bin/bash

# Setup pi agent configuration
# Links skills and prompts to ~/.pi/agent/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOTSHELL="${DOTSHELL:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PI_AGENT_DIR="$HOME/.pi/agent"

mkdir -p "$PI_AGENT_DIR"

# Link skills directories individually (not the whole skills directory)
SKILLS_SRC_DIR="$DOTSHELL/apps/agents/skills"
SKILLS_DST_DIR="$PI_AGENT_DIR/skills"

if [ -L "$SKILLS_DST_DIR" ]; then
    rm "$SKILLS_DST_DIR"
fi
mkdir -p "$SKILLS_DST_DIR"

if [ -d "$SKILLS_SRC_DIR" ]; then
    for skill_dir in "$SKILLS_SRC_DIR"/*; do
        [ -d "$skill_dir" ] || continue
        [ -f "$skill_dir/SKILL.md" ] || continue
        skill_name="$(basename "$skill_dir")"

        if [ -L "$SKILLS_DST_DIR/$skill_name" ]; then
            rm "$SKILLS_DST_DIR/$skill_name"
        fi
        ln -s "$skill_dir" "$SKILLS_DST_DIR/$skill_name"
        echo "✓ Linked skill $skill_name -> $SKILLS_DST_DIR/$skill_name"
    done
fi

if [ -L "$PI_AGENT_DIR/prompts" ]; then
    rm "$PI_AGENT_DIR/prompts"
fi
if [ -d "$SCRIPT_DIR/agent/prompts" ]; then
    ln -s "$SCRIPT_DIR/agent/prompts" "$PI_AGENT_DIR/prompts"
    echo "✓ Linked prompts -> $PI_AGENT_DIR/prompts"
fi

# Link extensions directory
if [ -L "$PI_AGENT_DIR/extensions" ]; then
    rm "$PI_AGENT_DIR/extensions"
fi
if [ -d "$SCRIPT_DIR/agent/extensions" ]; then
    ln -s "$SCRIPT_DIR/agent/extensions" "$PI_AGENT_DIR/extensions"
    echo "✓ Linked extensions -> $PI_AGENT_DIR/extensions"
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

# Link subagents directory
if [ -L "$PI_AGENT_DIR/agents" ]; then
    rm "$PI_AGENT_DIR/agents"
fi
if [ -d "$SCRIPT_DIR/agent/agents" ]; then
    ln -s "$SCRIPT_DIR/agent/agents" "$PI_AGENT_DIR/agents"
    echo "✓ Linked agents -> $PI_AGENT_DIR/agents"
fi

echo "Setup complete!"
