#!/usr/bin/env python3
# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "traceback-with-variables",
#     "translators",
#     "openai-whisper@https://github.com/openai/whisper.git",
# ]
# ///
import argparse
import logging
import os

import translators
import whisper

logging.basicConfig(level=logging.INFO)
# tiny, base, small, medium, large, turbo
whisper_model = "base"
trans_service = "bing"

class Transvideo:
    def __init__(self, video_file):
        self.video_file = video_file
        self.audio_file = os.path.splitext(video_file)[0] + '.wav'
        self.whisper_original_file = os.path.splitext(video_file)[0] + '.original.txt'
        self.whisper_combined_file = os.path.splitext(video_file)[0] + '.combined.txt'
        self.translate_file = os.path.splitext(video_file)[0] + '.trans.txt'
        self.srt_file = os.path.splitext(video_file)[0] + '.srt'
        self.output_file = os.path.splitext(video_file)[0] + '.trans' + os.path.splitext(video_file)[-1]

    def video_to_audio(self):
        logging.info('Converting video to audio...')

        command = f'ffmpeg -i "{self.video_file}" "{self.audio_file}"'
        exec_command(command)

    def save_whisper_result(self):
        logging.info('Getting whisper result...')

        if not os.path.exists(self.whisper_original_file):
            # tiny, base, small, medium, large, turbo
            model = whisper.load_model("small")
            audio = whisper.load_audio(self.audio_file)

            # mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(audio)).to(model.device)
            # _, probs = model.detect_language(mel)
            # logging.info(f"Detected language: {max(probs, key=probs.get)}")

            whisper_result = model.transcribe(
                verbose=True,
                audio=audio,
                language='en',
                fp16=False,
                word_timestamps=True,
            )

            content = []
            for index, segment in enumerate(whisper_result['segments']):
                start_time = seconds_to_hms(segment['start'])
                end_time = seconds_to_hms(segment['end'])
                segment_text = segment['text'].replace('\n', '').strip()
                content.append(f'{start_time}|{end_time}|{segment_text}')
            save_text_to_file('\n'.join(content), self.whisper_original_file)

        combined_result = []
        segment_text_list = []
        text_start_time = None
        with open(self.whisper_original_file, 'r') as f:
            whisper_original = f.read().strip().split('\n')
            for line in whisper_original:
                start_time, end_time, segment_text = line.split('|')
                segment_text_list.append(segment_text.strip())

                if text_start_time is None:
                    text_start_time = start_time
                if not segment_text or segment_text[-1] not in ['.', '!', '?', '。', '！', '？']:
                    continue

                text = ' '.join(segment_text_list)
                logging.info('%s %s', text_start_time, text)

                combined_result.append('|'.join([text_start_time, end_time, text]))

                segment_text_list = []
                text_start_time = None
        save_text_to_file('\n'.join(combined_result), self.whisper_combined_file)

    def translate_whisper_result(self):
        logging.info('Translating whisper result...')
        translate_result = []
        with open(self.whisper_combined_file, 'r') as f:
            for line in f.read().strip().split('\n'):
                start_time, end_time, text_original = line.split('|')
                text_translated = translators.translate_text(text_original, translator=trans_service, from_language='en', to_language='zh', if_ignore_limit_of_length=True)
                logging.info('%s %s %s', start_time, text_original, text_translated)
                translate_result.append('|'.join([start_time, end_time, text_original, text_translated]))
        save_text_to_file('\n'.join(translate_result), self.translate_file)

    def create_srt(self):
        logging.info('Converting whisper result to srt...')

        transcript_result = []
        index = 1
        with open(self.translate_file, 'r') as f:
            for line in f.read().strip().split('\n'):
                start_time, end_time, text_original, text_translated = line.split('|')
                transcript_result.append(str(index))
                transcript_result.append('{} --> {}'.format(start_time, end_time))
                transcript_result.append(text_original)
                transcript_result.append(text_translated)
                transcript_result.append('')

                index += 1
        save_text_to_file('\n'.join(transcript_result), self.srt_file)

    def compile_video_with_srt(self, soft=False):
        if soft:
            self._compile_video_with_srt_soft()
        else:
            self._compile_video_with_srt_hard()

    def _compile_video_with_srt_hard(self):
        logging.info('Compiling video with srt...')

        command = 'ffmpeg -i "{}" -vf "subtitles={}:force_style=\'FontSize=12,Fontname=PingFang SC\'" "{}"'.format(
            self.video_file, self.srt_file, self.output_file
        )
        exec_command(command)

    def _compile_video_with_srt_soft(self):
        logging.info('Compiling video with srt...')

        command = 'ffmpeg -i "{}" -i "{}" -c copy -c:s mov_text -metadata:s:s:0 language=eng "{}"'.format(
            self.video_file, self.srt_file, self.output_file
        )
        exec_command(command)


def seconds_to_hms(seconds):
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    hms = "%02d:%02d:%s" % (h, m, str('%.3f' % s).zfill(6))
    hms = hms.replace('.', ',')
    return hms


def exec_command(command):
    logging.info('Executing command: %s', command)

    os.system(command)


def save_text_to_file(text, filepath):
    logging.info('Saving text to file...')

    with open(filepath, 'w') as f:
        f.write(text)


def read_text_from_file(filepath):
    with open(filepath, 'r') as f:
        return f.read()


def parse_args():
    args = argparse.ArgumentParser(description='Transcribe video to text and translate to Chinese')
    args.add_argument('video_file')
    args.add_argument('--stages', action='append', choices=['audio', 'transcribe', 'translate', 'srt', 'compile'], default=[])
    args.add_argument('--soft', action='store_true')
    return args.parse_args()


def main():
    args = parse_args()
    logging.info('args: %s', args)

    video_file = os.path.expanduser(args.video_file)
    transvideo = Transvideo(video_file)
    if not args.stages or 'audio' in args.stages:
        transvideo.video_to_audio()
    if not args.stages or 'transcribe' in args.stages:
        transvideo.save_whisper_result()
    if not args.stages or 'translate' in args.stages:
        transvideo.translate_whisper_result()
    if not args.stages or 'srt' in args.stages:
        transvideo.create_srt()
    if not args.stages or 'compile' in args.stages:
        transvideo.compile_video_with_srt(soft=args.soft)


if __name__ == '__main__':
    # pip install traceback-with-variables
    from traceback_with_variables import activate_by_import
    main()
