# Write metadata for mp4 files by filename using exiftool.
# Assumes that the filename is in the format:
# <TV Show Name> - S<Season Number>E<Episode Number> - <Episode Title>.mp4

# Install exiftool using the following command:
#   brew install exiftool

# Usage: write-metadata.sh <directory>


# Check if the user has provided a directory
# If not, exit with an error message
if [ -z "$1" ]; then
    echo "Usage: write-metadata.sh <directory>"
    exit 1
fi

# Check if the directory exists
# If not, exit with an error message
if [ ! -d "$1" ]; then
    echo "Directory does not exist"
    exit 1
fi

# Change to the directory provided by the user
cd "$1"

# Loop through all the mp4 files in the directory
re_pattern='^[^-]* - S[0-9]EP[0-9][0-9] - .*\.mp4$'
for file in *.mp4; do
    # if not match, print error message and continue to next file
    if [[ ! $file =~ $re_pattern ]]; then
        echo "Error: Invalid filename format: $file"
        continue
    fi

    # Extract the TV show name, season number, episode number, and episode title from the filename
    tv_show_name=$(echo "$file" | cut -d'-' -f1 | xargs)
    season_number=$(echo "$file" | grep -o 'S[0-9]' | cut -c2-)
    episode_number=$(echo "$file" | grep -o 'EP[0-9][0-9]' | cut -c3-)
    episode_title=$(echo "$file" | cut -d'-' -f3 | cut -d'.' -f1 | xargs)

    # if not match, print error message and continue to next file
    if [ -z "$tv_show_name" ] || [ -z "$season_number" ] || [ -z "$episode_number" ] || [ -z "$episode_title" ]; then
        echo "Error: Could not extract metadata from filename: $file"
        continue
    fi

    # Write metadata for the mp4 file using exiftool
    echo "Writing metadata for: $file | $tv_show_name | $season_number | $episode_number | $episode_title"
    exiftool -MediaType="TV Show" -Title="$episode_title" \
        -Series="$tv_show_name" -SeasonNumber="$season_number" -EpisodeNumber="$episode_number" \
        -TVShow="$tv_show_name" -TVSeason="$season_number" -TVEpisode="$episode_number" \
        "$file"
done
