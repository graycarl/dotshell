# Make soft link from ~/.config/opencode/opencode.json to ./opencode.json

OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"


mkdir -p "$OPENCODE_CONFIG_DIR"

# config
if [ -L "$OPENCODE_CONFIG_DIR/opencode.json" ]; then
    rm "$OPENCODE_CONFIG_DIR/opencode.json"
fi
if [ -f "$SCRIPT_DIR/opencode.json" ]; then
    ln -s "$SCRIPT_DIR/opencode.json" "$OPENCODE_CONFIG_DIR/opencode.json"
    echo "✓ Linked opencode.json -> $OPENCODE_CONFIG_DIR/opencode.json"
fi

# skills
if [ -L "$OPENCODE_CONFIG_DIR/skills" ]; then
    rm "$OPENCODE_CONFIG_DIR/skills"
fi
if [ -d "$DOTSHELL/apps/agents/skills" ]; then
    ln -s "$DOTSHELL/apps/agents/skills" "$OPENCODE_CONFIG_DIR/skills"
    echo "✓ Linked skills -> $OPENCODE_CONFIG_DIR/skills"
fi

