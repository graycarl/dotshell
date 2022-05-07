#!/usr/bin/env bash
# Metadata allows your plugin to show up in the app, and website.
#
#  <xbar.title>Hammer</xbar.title>
#  <xbar.version>v1.0</xbar.version>
#  <xbar.author>Hongbo He</xbar.author>
#  <xbar.author.github>hhbcarl</xbar.author.github>
#  <xbar.desc>Hammer is here.</xbar.desc>

TMPDIR=/tmp/xbar/hammer
mkdir -p $TMPDIR
REPODIR=$HOME/.copy

# Create copy script
cat > $TMPDIR/copy-static.sh << END
#!/usr/bin/env bash -x
cat $REPODIR/\$1.static | tr -d '\n' | pbcopy
END

# Keep awake script
cat > $TMPDIR/keep-awake.sh << 'END'
#!/usr/bin/env bash
if [ "$1" = "start" ]; then
    nohup caffeinate -it 3600 > /dev/null &
else
    killall caffeinate
fi
sleep 1
END

chmod +x $TMPDIR/*.sh

echo 〄
echo ---
echo "Refresh | refresh=true"

echo "Copy"
for file in $REPODIR/*.static; do
    name=$(basename $file .static)
    echo "--$name | shell=$TMPDIR/copy-static.sh | param1=$name"
done


# Keep awake
if pgrep -q caffeinate; then
    echo "Cancel Keep Awake | refresh=true | shell=$TMPDIR/keep-awake.sh | param1=stop"
else
    echo "Keep Awake | refresh=true | shell=$TMPDIR/keep-awake.sh | param1=start"
fi
