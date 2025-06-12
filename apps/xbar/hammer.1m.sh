#!/usr/bin/env bash
# Metadata allows your plugin to show up in the app, and website.
#
#  <xbar.title>Hammer</xbar.title>
#  <xbar.version>v1.0</xbar.version>
#  <xbar.author>Hongbo He</xbar.author>
#  <xbar.author.github>hhbcarl</xbar.author.github>
#  <xbar.desc>Hammer is here.</xbar.desc>

TMPDIR=/tmp/xbar/hammer
TOOLSDIR=$HOME/.shell/tools
mkdir -p $TMPDIR
COPYREPO=$HOME/.shell/local/copy
SNIPREPO=$HOME/.shell/local/snippets

echo "Start at: $(date)" >> $TMPDIR/log

# Create copy script
cat > $TMPDIR/copy-static.sh << END
#!/usr/bin/env bash -x
cat $COPYREPO/\$1.static | tr -d '\n' | pbcopy
END
cat > $TMPDIR/copy-totp.sh << END
#!/usr/bin/env bash -x
key=\$(cat $COPYREPO/\$1.totp)
$TOOLSDIR/totp.py \$key | tr -d '\n' | pbcopy
END
cat > $TMPDIR/copy-pwgen.sh << END
#!/usr/bin/env bash -x
$TOOLSDIR/pwgen.sh | tr -d '\n' | pbcopy
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

echo Hm
echo ---
echo "Refresh | refresh=true"

echo "Copy"
for file in $COPYREPO/*.static; do
    name=$(basename $file .static)
    echo "--$name (static) | color=blue | shell=$TMPDIR/copy-static.sh | param1=$name"
done
for file in $COPYREPO/*.totp; do
    name=$(basename $file .totp)
    key=$(cat $file)
    echo "--$name (totp) | color=green | shell=$TMPDIR/copy-totp.sh | param1=$name"
done
echo "--PWGen | color=red | shell=$TMPDIR/copy-pwgen.sh"

echo "Snippets"
for file in $SNIPREPO/*.txt; do
    name=$(basename $file .txt)
    for line in $(cat $file); do
        echo "--[${name}] > $line | length=30 | ansi=false | shell=/bin/bash | param1='-c' | param2='echo \"$line\" | LANG=zh_CN.UTF-8 pbcopy' | terminal=false"
    done
done

echo "Open"
/opt/homebrew/bin/docker container ls --format '{{.Names}} {{.Ports}}' | while read line; do
    if [[ $line =~ .*(127\.0\.0\.1|0\.0\.0\.0).* ]]; then
        words=($line)
        for host in $(echo $line | egrep -o '(127.0.0.1|0.0.0.0):\d+'); do
            echo "--${words[0]} -> $host | shell=/usr/bin/open | param1=http://$host"
        done
    else
        continue
    fi
done

echo "Sync Notes"
SN_LOG=/tmp/sync-notes.log
$HOME/.shell/tools/git-sync.sh $HOME/Documents/Notes >> $SN_LOG 2>&1
tail -r -n 10 $SN_LOG | sed -E 's/^/--/'

# Keep awake
if pgrep -q caffeinate; then
    echo "Cancel Keep Awake | refresh=true | shell=$TMPDIR/keep-awake.sh | param1=stop"
else
    echo "Keep Awake | refresh=true | shell=$TMPDIR/keep-awake.sh | param1=start"
fi

echo "Brew update"
BU_LOG=/tmp/brew-update/$(date +%Y-%m-%d).log
mkdir -p $(dirname $BU_LOG)
if [ -f $BU_LOG ]; then
    echo "--Updated at $(stat -f %Sm $BU_LOG) | color=green"
    tail -n 10 $BU_LOG | sed -E 's/^/--/'
else
    touch $BU_LOG
    echo "--Updating..."
    /opt/homebrew/bin/brew update >> $BU_LOG 2>&1 &
fi

echo "End at  : $(date)" >> $TMPDIR/log
