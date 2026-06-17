import os
import re
import subprocess
from glob import glob
from collections import defaultdict
from datetime import datetime, timedelta
import multiprocessing
from functools import partial

INPUT_DIR = "D:\\ISS_MEDIA\\CAM_1\\2025-06-17T09+0300"
OUTPUT_DIR = "mp4_conversion"
VIDEO_DURATION_SECONDS = 1.0214
VIDEOS_PER_GROUP = 881  
INPUT_CODEC = 'h264'
PARALLEL_PROCESSES = 2  # Number of parallel processes to use


def extract_date_from_path(path):
    # Extract date from folder name (format: yyyy-MM-ddThh+zzzz)
    date_match = re.search(r'(\d{4}-\d{2}-\d{2}T\d{2}\+\d{4})', path)
    return date_match.group(1) if date_match else "unknown_date"

def extract_camera_id(filename):
    # Extract camera ID from filename (format: xx-xx-xxx_N.issvd)
    cam_match = re.search(r'_(\d+)\.issvd$', filename)
    return cam_match.group(1) if cam_match else "unknown_camera"

def extract_timestamp(filename):
    # Extract timestamp (e.g., "18-04-884" part)
    time_match = re.search(r'(\d{2}-\d{2}-\d{3})_', filename)
    return time_match.group(1) if time_match else "00-00-000"

def parse_timestamp(timestamp):
    # Parse timestamp like "18-04-884" into hours and minutes
    parts = timestamp.split('-')
    if len(parts) == 3:
        hour, minute, _ = parts
        return int(hour), int(minute)
    return 0, 0

def convert_to_mp4(input_file, output_file):
    """Convert .issvd file to .mp4 using ffmpeg"""
    try:
        cmd = [
            'ffmpeg',
            '-f', INPUT_CODEC,              # Force input format to h264
            '-i', input_file,          # Input file
            '-c:v', 'copy',            # Copy video stream without re-encoding
            '-f', 'mp4',               # Force output format to mp4
            output_file,               # Output file
            '-y'                       # Overwrite output file if exists
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"Error converting {input_file}: {result.stderr}")
            return False
        return True
    except Exception as e:
        print(f"Exception while converting {input_file}: {str(e)}")
        return False

def concatenate_mp4_files(mp4_files, output_file):
    """Concatenate multiple mp4 files into a single file using ffmpeg"""
    try:
        # Create a temporary text file with the list of files to concatenate
        output_dir = os.path.dirname(output_file)
        concat_list_path = os.path.join(output_dir, "concat_list.txt")
        
        # Ensure output directory exists
        os.makedirs(output_dir, exist_ok=True)
        
        with open(concat_list_path, 'w') as f:
            for file in mp4_files:
                # Use absolute paths with forward slashes for ffmpeg
                abs_path = os.path.abspath(file).replace('\\', '/')
                f.write(f"file '{abs_path}'\n")
        
        # Run ffmpeg to concatenate the files
        cmd = [
            'ffmpeg',
            '-f', 'concat',       # Format is concat
            '-safe', '0',         # Don't restrict filenames
            '-i', concat_list_path,  # Input file is the concat list
            '-c', 'copy',         # Copy streams without re-encoding
            output_file           # Output file
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        # Delete the temporary concat list file
        if os.path.exists(concat_list_path):
            os.remove(concat_list_path)
        
        if result.returncode != 0:
            print(f"Error concatenating files: {result.stderr}")
            return False
        return True
    except Exception as e:
        print(f"Exception while concatenating files: {str(e)}")
        if os.path.exists(concat_list_path):
            os.remove(concat_list_path)
        return False

def remove_individual_files(files):
    """Remove individual MP4 files after successful concatenation"""
    for file in files:
        try:
            os.remove(file)
            print(f"      Removed: {os.path.basename(file)}")
        except Exception as e:
            print(f"      Warning: Could not remove {os.path.basename(file)}: {str(e)}")

def process_group(group_data):
    """Process a single group of videos"""
    i, group, camera_id, date = group_data
    first_timestamp = group[0][0]
    last_timestamp = group[-1][0]
    num_videos = len(group)
    duration_minutes = (num_videos * VIDEO_DURATION_SECONDS) / 60.0
    
    print(f"    Group {i+1}: [{first_timestamp} to {last_timestamp}] - {num_videos} videos ({duration_minutes:.2f} minutes)")
    
    # Create output directory for this group
    camera_folder = f"CAM_{camera_id}"
    group_folder = f"group{i+1}"
    output_path = os.path.join(OUTPUT_DIR, camera_folder, date, group_folder)
    os.makedirs(output_path, exist_ok=True)
    
    print(f"      Saving converted videos to: {output_path}")
    
    # List to store paths of successfully converted mp4 files
    converted_files = []
    
    # Convert each file in the group
    for timestamp, file in group:
        filename = os.path.basename(file)
        base_name = os.path.splitext(filename)[0]
        output_file = os.path.join(output_path, f"{base_name}.mp4")
        
        print(f"      Converting: {filename} -> {os.path.basename(output_file)}")
        success = convert_to_mp4(file, output_file)
        
        if success:
            print(f"      ✓ Converted successfully: {os.path.basename(output_file)}")
            converted_files.append(output_file)
        else:
            print(f"      ✗ Conversion failed: {filename}")
    
    # Concatenate all converted files in this group into a single file
    if converted_files:
        # Create the output concatenated file name
        concat_output = os.path.join(output_path, f"{first_timestamp}_to_{last_timestamp}_{camera_id}.mp4")
        print(f"      Concatenating {len(converted_files)} files into: {os.path.basename(concat_output)}")
        
        # Perform concatenation
        success = concatenate_mp4_files(converted_files, concat_output)
        
        if success:
            print(f"      ✓ Concatenation successful: {os.path.basename(concat_output)}")
            # Remove individual files after successful concatenation
            print(f"      Removing individual MP4 files...")
            remove_individual_files(converted_files)
        else:
            print(f"      ✗ Concatenation failed")

def main():
    win_path = os.path.join(INPUT_DIR, "*.issvd")
    print(win_path)
    files = glob(os.path.join(INPUT_DIR, "*.issvd"))
    print(f"Found {len(files)} files to convert")
    
    # Group files by date and camera ID
    grouped_files = defaultdict(lambda: defaultdict(list))
    
    for file in files:
        date = extract_date_from_path(file)
        filename = os.path.basename(file)
        camera_id = extract_camera_id(filename)
        timestamp = extract_timestamp(filename)
        
        # Store file with its timestamp for sorting
        grouped_files[date][camera_id].append((timestamp, file))
    
    # Process grouped files
    for date in sorted(grouped_files.keys()):
        print(f"\nDate: {date}")
        
        for camera_id in sorted(grouped_files[date].keys(), key=int):
            print(f"  Camera ID: {camera_id}")
            
            # Sort files by timestamp
            sorted_files = sorted(grouped_files[date][camera_id])
            
            # Group into chunks
            video_groups = []
            for i in range(0, len(sorted_files), VIDEOS_PER_GROUP):
                video_groups.append(sorted_files[i:i + VIDEOS_PER_GROUP])
            
            # Prepare data for parallel processing
            group_data = [(i, group, camera_id, date) for i, group in enumerate(video_groups)]
            
            # Process groups in parallel
            with multiprocessing.Pool(processes=PARALLEL_PROCESSES) as pool:
                pool.map(process_group, group_data)

if __name__ == "__main__":
    # Set multiprocessing start method
    multiprocessing.set_start_method('spawn')
    main()

