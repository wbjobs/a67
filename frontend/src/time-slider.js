export class TimeSlider {
  constructor() {
    this.track = document.getElementById('slider-track');
    this.fill = document.getElementById('slider-fill');
    this.handleLeft = document.getElementById('handle-left');
    this.handleRight = document.getElementById('handle-right');
    this.sliderRange = document.getElementById('slider-range');
    this.timeStartLabel = document.getElementById('time-start');
    this.timeEndLabel = document.getElementById('time-end');
    this.timeRangeDisplay = document.getElementById('time-range-display');
    this.presetButtons = document.querySelectorAll('.preset-btn');

    this.minTime = 0;
    this.maxTime = 0;
    this.startPercent = 80;
    this.endPercent = 100;
    this.dragging = null;
    this.onTimeWindowChange = null;
    this.debounceTimer = null;

    this._init();
  }

  _init() {
    this.track.addEventListener('mousedown', (e) => this._onTrackClick(e));

    this.handleLeft.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this._startDrag('left', e);
    });

    this.handleRight.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      this._startDrag('right', e);
    });

    document.addEventListener('mousemove', (e) => this._onDrag(e));
    document.addEventListener('mouseup', () => this._stopDrag());

    this.handleLeft.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._startDrag('left', e.touches[0]);
    });

    this.handleRight.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._startDrag('right', e.touches[0]);
    });

    document.addEventListener('touchmove', (e) => {
      if (this.dragging) {
        e.preventDefault();
        this._onDrag(e.touches[0]);
      }
    }, { passive: false });

    document.addEventListener('touchend', () => this._stopDrag());

    this.presetButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const minutes = parseInt(e.target.dataset.minutes);
        this._setPresetWindow(minutes);
      });
    });

    this._updateUI();
  }

  setTimeRange(minTime, maxTime) {
    this.minTime = minTime;
    this.maxTime = maxTime;

    this.startPercent = 80;
    this.endPercent = 100;

    this._updateUI();
    this._notifyChange();
  }

  _setPresetWindow(minutes) {
    this.presetButtons.forEach(btn => btn.classList.remove('active'));
    document.querySelector(`[data-minutes="${minutes}"]`).classList.add('active');

    if (this.maxTime > 0) {
      const windowSeconds = minutes * 60;
      const totalRange = this.maxTime - this.minTime;

      if (windowSeconds >= totalRange) {
        this.startPercent = 0;
        this.endPercent = 100;
      } else {
        this.endPercent = 100;
        this.startPercent = 100 - (windowSeconds / totalRange * 100);
      }

      this._updateUI();
      this._notifyChange();
    }
  }

  _startDrag(handle, event) {
    this.dragging = handle;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  _stopDrag() {
    if (this.dragging) {
      this.dragging = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this._notifyChange();
    }
  }

  _onTrackClick(event) {
    if (this.dragging) return;

    const rect = this.track.getBoundingClientRect();
    const percent = ((event.clientX - rect.left) / rect.width) * 100;
    const clampedPercent = Math.max(0, Math.min(100, percent));

    const distanceLeft = Math.abs(clampedPercent - this.startPercent);
    const distanceRight = Math.abs(clampedPercent - this.endPercent);

    if (distanceLeft < distanceRight) {
      this.startPercent = Math.min(clampedPercent, this.endPercent - 5);
    } else {
      this.endPercent = Math.max(clampedPercent, this.startPercent + 5);
    }

    this._updateUI();
    this._notifyChange();
  }

  _onDrag(event) {
    if (!this.dragging) return;

    const rect = this.track.getBoundingClientRect();
    let percent = ((event.clientX - rect.left) / rect.width) * 100;
    percent = Math.max(0, Math.min(100, percent));

    if (this.dragging === 'left') {
      this.startPercent = Math.min(percent, this.endPercent - 5);
    } else if (this.dragging === 'right') {
      this.endPercent = Math.max(percent, this.startPercent + 5);
    }

    this._updateUI();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this._notifyChange();
    }, 100);
  }

  _updateUI() {
    this.fill.style.left = this.startPercent + '%';
    this.fill.style.width = (this.endPercent - this.startPercent) + '%';

    this.handleLeft.style.left = this.startPercent + '%';
    this.handleRight.style.left = this.endPercent + '%';

    const startTime = this._percentToTime(this.startPercent);
    const endTime = this._percentToTime(this.endPercent);

    this.timeStartLabel.textContent = this._formatTime(startTime);
    this.timeEndLabel.textContent = this._formatTime(endTime);

    const rangeText = this._formatDuration(endTime - startTime);
    this.timeRangeDisplay.textContent = `窗口大小: ${rangeText}`;

    const midPercent = (this.startPercent + this.endPercent) / 2;
    this.sliderRange.style.left = midPercent + '%';
    this.sliderRange.textContent = `${rangeText}`;

    this.presetButtons.forEach(btn => {
      btn.classList.remove('active');
    });
  }

  _percentToTime(percent) {
    if (this.maxTime <= this.minTime) return Date.now() / 1000;
    return this.minTime + (this.maxTime - this.minTime) * (percent / 100);
  }

  _formatTime(timestamp) {
    if (!timestamp || timestamp === 0) return '--:--:--';
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  _formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0秒';
    seconds = Math.floor(seconds);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}小时${minutes}分钟`;
    } else if (minutes > 0) {
      return `${minutes}分钟${secs}秒`;
    } else {
      return `${secs}秒`;
    }
  }

  _notifyChange() {
    if (this.onTimeWindowChange && this.maxTime > this.minTime) {
      const startTime = this._percentToTime(this.startPercent);
      const endTime = this._percentToTime(this.endPercent);
      this.onTimeWindowChange(startTime, endTime);
    }
  }

  getTimeWindow() {
    return {
      start: this._percentToTime(this.startPercent),
      end: this._percentToTime(this.endPercent)
    };
  }

  setTimeWindowChangeHandler(handler) {
    this.onTimeWindowChange = handler;
  }
}

export default TimeSlider;
